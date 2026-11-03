use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;
use whisper_rs::{
    get_lang_id, get_lang_str, FullParams, SamplingStrategy, WhisperContext,
    WhisperContextParameters, WhisperError, WhisperState,
};

const MAX_RECORDING_SECONDS: usize = 120;
const SAMPLE_RATE: usize = 16_000;
const LIVE_PREVIEW_SECONDS: usize = 8;
const CLIPBOARD_RESTORE_DELAY_MS: u64 = 180;
const UNDO_WINDOW_MS: u64 = 5 * 60 * 1_000;

#[derive(Clone, Copy)]
struct ModelDescriptor {
    profile: &'static str,
    display_name: &'static str,
    file: &'static str,
    url: &'static str,
    sha256: &'static str,
    bytes: u64,
    size_mb: u64,
    quality: &'static str,
}

// These are fixed, reviewed artifacts from whisper.cpp's public model store.
// Downloads are accepted only when both the exact byte length and SHA-256 match.
const MODEL_PROFILES: [ModelDescriptor; 3] = [
    ModelDescriptor {
        profile: "fast",
        display_name: "Whisper base · multilingual",
        file: "ggml-base.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
        bytes: 147_951_465,
        size_mb: 142,
        quality: "Fastest local dictation",
    },
    ModelDescriptor {
        profile: "balanced",
        display_name: "Whisper small · multilingual",
        file: "ggml-small.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        bytes: 487_601_967,
        size_mb: 466,
        quality: "Better multilingual accuracy",
    },
    ModelDescriptor {
        profile: "best",
        display_name: "Whisper medium · multilingual",
        file: "ggml-medium.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
        sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
        bytes: 1_533_763_059,
        size_mb: 1_463,
        quality: "Best Hebrew and multilingual accuracy",
    },
];

static LAST_INSERTION_AT_MS: AtomicU64 = AtomicU64::new(0);

struct LoadedWhisperContext {
    model_path: PathBuf,
    context: Arc<WhisperContext>,
}

#[derive(Default, Clone)]
pub struct WhisperEngine {
    context: Arc<Mutex<Option<LoadedWhisperContext>>>,
    inference: Arc<Mutex<()>>,
    cancellation: Arc<AtomicU64>,
    last_failure: Arc<Mutex<Option<TranscriptionFailure>>>,
}

#[derive(Default)]
pub struct NativeAudioRecorder(pub Mutex<Option<NativeAudioCapture>>, Mutex<Option<String>>);

pub struct NativeAudioCapture {
    stream: cpal::Stream,
    samples: Arc<Mutex<Vec<f32>>>,
    error: Arc<Mutex<Option<String>>>,
    sample_rate: u32,
    channels: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioResult {
    samples: Vec<f32>,
    captured_seconds: f32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    ready: bool,
    name: &'static str,
    size_mb: u64,
    profile: &'static str,
    file: &'static str,
    quality: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProfileStatus {
    profile: &'static str,
    name: &'static str,
    size_mb: u64,
    quality: &'static str,
    ready: bool,
    active_by_default: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInputDevice {
    id: String,
    name: String,
    is_default: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionFailure {
    stage: &'static str,
    code: &'static str,
    message: String,
    retryable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionDiagnosticReport {
    ready: bool,
    checked_at: u64,
    backend: &'static str,
    supported_languages: [&'static str; 4],
    model: ModelStatus,
    input_devices: Vec<AudioInputDevice>,
    selected_input_device: Option<String>,
    default_input_device: Option<String>,
    capture_active: bool,
    capture_seconds: f32,
    capture_error: Option<String>,
    accessibility_granted: bool,
    notes: Vec<String>,
}

#[derive(Clone, Serialize)]
struct DownloadProgress {
    downloaded: u64,
    total: u64,
    percent: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeRequest {
    samples: Vec<f32>,
    language: Option<String>,
    save_recording: bool,
    #[serde(default)]
    profile: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTranscribeRequest {
    language: Option<String>,
    save_recording: bool,
    #[serde(default)]
    profile: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingEntry {
    id: String,
    title: String,
    created_at: u64,
    duration_seconds: f32,
    words: usize,
    transcript: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResult {
    text: String,
    recording: Option<RecordingEntry>,
    captured_seconds: f32,
    speech_seconds: f32,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|_| "The application data directory is unavailable.".to_string())
}

fn model_descriptor(profile: Option<&str>) -> Result<&'static ModelDescriptor, String> {
    let profile = profile.filter(|value| !value.is_empty()).unwrap_or("fast");
    MODEL_PROFILES
        .iter()
        .find(|descriptor| descriptor.profile == profile)
        .ok_or_else(|| "Choose a supported local model profile.".to_string())
}

fn model_path_for(app: &AppHandle, descriptor: &ModelDescriptor) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("models").join(descriptor.file))
}

fn recordings_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("recordings"))
}

fn verify_model_file(path: &Path, descriptor: &ModelDescriptor) -> bool {
    if path.metadata().map(|metadata| metadata.len()).ok() != Some(descriptor.bytes) {
        return false;
    }
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let Ok(read) = file.read(&mut buffer) else {
            return false;
        };
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    format!("{:x}", hasher.finalize()) == descriptor.sha256
}

fn status_for_model(
    app: &AppHandle,
    descriptor: &'static ModelDescriptor,
) -> Result<ModelStatus, String> {
    let path = model_path_for(app, descriptor)?;
    Ok(ModelStatus {
        ready: verify_model_file(&path, descriptor),
        name: descriptor.display_name,
        size_mb: descriptor.size_mb,
        profile: descriptor.profile,
        file: descriptor.file,
        quality: descriptor.quality,
    })
}

#[tauri::command]
pub fn whisper_model_status(app: AppHandle) -> Result<ModelStatus, String> {
    status_for_model(&app, &MODEL_PROFILES[0])
}

#[tauri::command]
pub fn whisper_model_profiles(app: AppHandle) -> Result<Vec<ModelProfileStatus>, String> {
    MODEL_PROFILES
        .iter()
        .map(|descriptor| {
            let path = model_path_for(&app, descriptor)?;
            Ok(ModelProfileStatus {
                profile: descriptor.profile,
                name: descriptor.display_name,
                size_mb: descriptor.size_mb,
                quality: descriptor.quality,
                ready: verify_model_file(&path, descriptor),
                active_by_default: descriptor.profile == "fast",
            })
        })
        .collect()
}

#[tauri::command]
pub fn whisper_model_status_for_profile(
    app: AppHandle,
    profile: String,
) -> Result<ModelStatus, String> {
    status_for_model(&app, model_descriptor(Some(&profile))?)
}

#[tauri::command]
pub async fn download_whisper_model(app: AppHandle) -> Result<(), String> {
    download_whisper_model_for_profile(app, "fast".into()).await
}

#[tauri::command]
pub async fn download_whisper_model_for_profile(
    app: AppHandle,
    profile: String,
) -> Result<(), String> {
    let descriptor = *model_descriptor(Some(&profile))?;
    let destination = model_path_for(&app, &descriptor)?;
    if verify_model_file(&destination, &descriptor) {
        return Ok(());
    }
    if destination.exists() {
        let _ = tokio::fs::remove_file(&destination).await;
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "The model directory is invalid.".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|_| "The model directory could not be created.".to_string())?;
    let temporary = destination.with_extension("download");
    let client = reqwest::Client::builder()
        .https_only(true)
        .timeout(std::time::Duration::from_secs(900))
        .build()
        .map_err(|_| "The model download client could not be created.".to_string())?;
    let mut response = client
        .get(descriptor.url)
        .send()
        .await
        .map_err(|_| "The Whisper model download could not be started.".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "The Whisper model server returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    let total = response
        .content_length()
        .ok_or_else(|| "The model server did not provide a file size.".to_string())?;
    if total != descriptor.bytes {
        return Err("The model server returned an unexpected file size.".into());
    }
    let mut file = tokio::fs::File::create(&temporary)
        .await
        .map_err(|_| "The temporary model file could not be created.".to_string())?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0_u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The model download was interrupted.".to_string())?
    {
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > descriptor.bytes {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err("The model download exceeded the reviewed limit.".into());
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|_| "The model could not be written to disk.".to_string())?;
        let _ = app.emit(
            "model-download-progress",
            DownloadProgress {
                downloaded,
                total,
                percent: ((downloaded.saturating_mul(100) / total).min(100)) as u8,
            },
        );
    }
    file.flush()
        .await
        .map_err(|_| "The model file could not be finalized.".to_string())?;
    drop(file);
    let actual_hash = format!("{:x}", hasher.finalize());
    if downloaded != descriptor.bytes || actual_hash != descriptor.sha256 {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err("The downloaded model failed its integrity check.".into());
    }
    tokio::fs::rename(&temporary, &destination)
        .await
        .map_err(|_| "The verified model could not be installed.".to_string())?;
    let _ = app.emit("model-download-complete", descriptor.profile);
    Ok(())
}

fn validate_samples(samples: &[f32]) -> Result<(), String> {
    if samples.len() < SAMPLE_RATE / 4 {
        return Err("The recording was too short to transcribe.".into());
    }
    if samples.len() > SAMPLE_RATE * MAX_RECORDING_SECONDS {
        return Err("Recordings are limited to two minutes.".into());
    }
    if samples
        .iter()
        .any(|sample| !sample.is_finite() || sample.abs() > 4.0)
    {
        return Err("The recording contained invalid audio samples.".into());
    }
    let peak = samples
        .iter()
        .fold(0.0_f32, |maximum, sample| maximum.max(sample.abs()));
    let rms =
        (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt();
    if peak < 0.006 || rms < 0.0015 {
        return Err(
            "No speech was detected. Silence and steady background noise were ignored.".into(),
        );
    }
    Ok(())
}

fn load_context(
    engine: &Arc<Mutex<Option<LoadedWhisperContext>>>,
    model: &Path,
) -> Result<Arc<WhisperContext>, String> {
    let mut guard = engine
        .lock()
        .map_err(|_| "The local transcription engine is unavailable.".to_string())?;
    let must_load = guard
        .as_ref()
        .map_or(true, |loaded| loaded.model_path != model);
    if must_load {
        let path = model
            .to_str()
            .ok_or_else(|| "The model path is invalid.".to_string())?;
        let mut context_parameters = WhisperContextParameters::default();
        // Keep inference on the CPU. This avoids backend-specific encoder
        // failures and makes behavior consistent across supported Macs.
        context_parameters.use_gpu(false);
        let context = WhisperContext::new_with_params(path, context_parameters)
            .map_err(|_| "The local Whisper model could not be loaded.".to_string())?;
        *guard = Some(LoadedWhisperContext {
            model_path: model.to_owned(),
            context: Arc::new(context),
        });
    }
    guard
        .as_ref()
        .map(|loaded| loaded.context.clone())
        .ok_or_else(|| "The local Whisper model could not be loaded.".to_string())
}

fn whisper_was_canceled(cancellation: &Option<(Arc<AtomicU64>, u64)>) -> bool {
    cancellation
        .as_ref()
        .is_some_and(|(signal, generation)| signal.load(Ordering::Acquire) != *generation)
}

fn is_encoder_failure(error: &WhisperError) -> bool {
    matches!(
        error,
        WhisperError::GenericError(-6) | WhisperError::FailedToEncode
    )
}

fn english_or_hebrew(probabilities: &[f32]) -> &'static str {
    let probability = |language: &str| {
        get_lang_id(language)
            .and_then(|id| probabilities.get(id as usize))
            .copied()
            .unwrap_or_default()
    };
    if probability("he") > probability("en") {
        "he"
    } else {
        "en"
    }
}

#[tauri::command]
pub async fn preload_whisper_model(
    app: AppHandle,
    engine: State<'_, WhisperEngine>,
) -> Result<(), String> {
    preload_whisper_model_for_profile(app, engine, "fast".into()).await
}

#[tauri::command]
pub async fn preload_whisper_model_for_profile(
    app: AppHandle,
    engine: State<'_, WhisperEngine>,
    profile: String,
) -> Result<(), String> {
    let descriptor = model_descriptor(Some(&profile))?;
    let model = model_path_for(&app, descriptor)?;
    if !verify_model_file(&model, descriptor) {
        return Err("The local Whisper model is not installed.".into());
    }
    let engine = engine.context.clone();
    tauri::async_runtime::spawn_blocking(move || load_context(&engine, &model).map(|_| ()))
        .await
        .map_err(|_| "The local transcription engine could not be prepared.".to_string())?
}

fn transcribe_samples(
    engine: Arc<Mutex<Option<LoadedWhisperContext>>>,
    inference: Arc<Mutex<()>>,
    model: &Path,
    samples: &[f32],
    language: Option<&str>,
    cancellation: Option<(Arc<AtomicU64>, u64)>,
    preview: bool,
) -> Result<String, String> {
    // whisper.cpp may share a loaded model between states, but concurrent
    // inference against the same context is not reliable. A live pill
    // preview can still be winding down when the final transcription starts,
    // so serialize both paths at the native boundary.
    let _inference_guard = inference
        .lock()
        .map_err(|_| "The local transcription engine is unavailable.".to_string())?;
    if whisper_was_canceled(&cancellation) {
        return Err("Transcription canceled.".into());
    }
    let bilingual_mode = matches!(language, Some("en-he"));
    let whisper_language = match language {
        None | Some("") | Some("auto") | Some("en-he") => None,
        Some("en") => Some("en"),
        Some("he") => Some("he"),
        Some(_) => return Err("Choose a supported dictation language.".into()),
    };
    let context = load_context(&engine, model)?;
    let thread_count = std::thread::available_parallelism()
        .map(|threads| threads.get().min(8) as i32)
        .unwrap_or(4);
    let resolved_language = if whisper_language.is_none() {
        // whisper_full performs automatic language detection and transcription
        // with two encoder passes on the same state. The bundled backend can
        // intermittently fail the second pass. Detect on a disposable state,
        // then transcribe with the detected language on a fresh state.
        let mut detection_state = context.create_state().map_err(|_| {
            "A Whisper language detection session could not be created.".to_string()
        })?;
        detection_state
            .pcm_to_mel(samples, thread_count as usize)
            .map_err(|error| format!("Whisper could not prepare language detection ({error})."))?;
        let (language_id, probabilities) = detection_state
            .lang_detect(0, thread_count as usize)
            .map_err(|error| format!("Whisper could not detect the spoken language ({error})."))?;
        let detected = if bilingual_mode {
            // Short Hebrew phrases are often classified as a neighboring
            // language by the base model. In bilingual mode, compare the
            // English and Hebrew probabilities directly instead of letting an
            // unrelated language win the automatic detector.
            english_or_hebrew(&probabilities)
        } else {
            get_lang_str(language_id)
                .ok_or_else(|| "Whisper detected an unsupported spoken language.".to_string())?
        };
        drop(detection_state);
        if whisper_was_canceled(&cancellation) {
            return Err("Transcription canceled.".into());
        }
        Some(detected)
    } else {
        whisper_language
    };
    let mut state = context
        .create_state()
        .map_err(|_| "A Whisper transcription session could not be created.".to_string())?;
    let mut params = FullParams::new(SamplingStrategy::Greedy {
        best_of: if preview { 1 } else { 3 },
    });
    params.set_language(resolved_language);
    params.set_translate(false);
    params.set_no_context(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_suppress_blank(true);
    params.set_suppress_nst(true);
    if resolved_language == Some("he") {
        params.set_initial_prompt("עברית תקנית עם פיסוק טבעי. שמות ומונחים יכולים להישאר באנגלית.");
    }
    if preview {
        // A live preview favors latency over long-form context. Eight seconds
        // of audio only needs a fraction of Whisper's 30-second encoder.
        params.set_single_segment(true);
        params.set_no_timestamps(true);
        params.set_audio_ctx(512);
        params.set_max_tokens(64);
    }
    let cancellation_check = cancellation;
    params.set_n_threads(thread_count);
    let mut transcription = state.full(params, samples);
    if whisper_was_canceled(&cancellation_check) {
        return Err("Transcription canceled.".into());
    }

    // whisper.cpp reports encoder failures as -6. Retry once with a fresh
    // state and a conservative thread count before failing the final
    // dictation. The current whisper-rs safe abort callback corrupts its
    // callback userdata, which can produce a false abort and this exact -6;
    // cancellation is therefore checked around inference instead.
    if transcription.as_ref().is_err_and(is_encoder_failure) {
        drop(state);
        let mut state = context
            .create_state()
            .map_err(|_| "A Whisper transcription session could not be restarted.".to_string())?;
        let mut retry_params = FullParams::new(SamplingStrategy::Greedy {
            best_of: if preview { 1 } else { 3 },
        });
        retry_params.set_language(resolved_language);
        retry_params.set_translate(false);
        retry_params.set_no_context(true);
        retry_params.set_print_special(false);
        retry_params.set_print_progress(false);
        retry_params.set_print_realtime(false);
        retry_params.set_print_timestamps(false);
        retry_params.set_suppress_blank(true);
        retry_params.set_suppress_nst(true);
        if resolved_language == Some("he") {
            retry_params.set_initial_prompt(
                "עברית תקנית עם פיסוק טבעי. שמות ומונחים יכולים להישאר באנגלית.",
            );
        }
        if preview {
            retry_params.set_single_segment(true);
            retry_params.set_no_timestamps(true);
            retry_params.set_audio_ctx(512);
            retry_params.set_max_tokens(64);
        }
        retry_params.set_n_threads(thread_count.min(4));
        transcription = state.full(retry_params, samples);
        if whisper_was_canceled(&cancellation_check) {
            return Err("Transcription canceled.".into());
        }
        transcription.map_err(|error| {
            if is_encoder_failure(&error) {
                "Whisper encoder error (-6) after a safe CPU retry. The recording is intact; retry it or run the transcription self-test.".to_string()
            } else {
                format!("Local Whisper could not transcribe the recording ({error}).")
            }
        })?;
        return accepted_transcription(&state);
    }
    transcription.map_err(|error| {
        if is_encoder_failure(&error) {
            "Whisper encoder error (-6) after a safe CPU retry. The recording is intact; retry it or run the transcription self-test.".to_string()
        } else {
            format!("Local Whisper could not transcribe the recording ({error}).")
        }
    })?;
    accepted_transcription(&state)
}

/// Keep Whisper's language model from turning silence or an isolated sound
/// into a plausible stock phrase. The acoustic no-speech score is evaluated
/// before any text is allowed to reach cleanup or insertion.
fn accepted_transcription(state: &WhisperState) -> Result<String, String> {
    const MINIMUM_SPEECH_PROBABILITY: f32 = 0.28;

    let mut text = String::new();
    let mut strongest_speech_probability = 0.0_f32;
    let mut observed_probability = false;
    for segment in state.as_iter() {
        text.push_str(&segment.to_string());
        let no_speech = segment.no_speech_probability();
        if no_speech.is_finite() {
            observed_probability = true;
            strongest_speech_probability =
                strongest_speech_probability.max(1.0 - no_speech.clamp(0.0, 1.0));
        }
    }
    let text = text.trim().to_owned();
    if text.is_empty()
        || (observed_probability && strongest_speech_probability < MINIMUM_SPEECH_PROBABILITY)
    {
        return Err("No speech was detected. Non-speech sounds were ignored.".into());
    }
    Ok(text)
}

fn save_recording(
    directory: &Path,
    samples: &[f32],
    transcript: &str,
) -> Result<RecordingEntry, String> {
    fs::create_dir_all(directory)
        .map_err(|_| "The recording archive could not be created.".to_string())?;
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "The system clock is invalid.".to_string())?
        .as_millis() as u64;
    let id = created_at.to_string();
    let wav_path = directory.join(format!("{id}.wav"));
    let json_path = directory.join(format!("{id}.json"));
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE as u32,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(&wav_path, spec)
        .map_err(|_| "The recording could not be saved.".to_string())?;
    for sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        writer
            .write_sample(value)
            .map_err(|_| "The recording could not be saved.".to_string())?;
    }
    writer
        .finalize()
        .map_err(|_| "The recording could not be finalized.".to_string())?;
    let title = transcript
        .split_whitespace()
        .take(6)
        .collect::<Vec<_>>()
        .join(" ");
    let recording = RecordingEntry {
        id,
        title: if title.is_empty() {
            "Untitled recording".into()
        } else {
            title
        },
        created_at,
        duration_seconds: samples.len() as f32 / SAMPLE_RATE as f32,
        words: transcript.split_whitespace().count(),
        transcript: transcript.to_owned(),
    };
    let metadata = serde_json::to_vec(&recording)
        .map_err(|_| "The recording metadata could not be encoded.".to_string())?;
    fs::write(json_path, metadata)
        .map_err(|_| "The recording metadata could not be saved.".to_string())?;
    Ok(recording)
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> u8;
}

fn input_permission_granted() -> bool {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: AXIsProcessTrusted takes no arguments and only reads TCC state.
        unsafe { AXIsProcessTrusted() != 0 }
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[tauri::command]
pub fn request_input_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        // AX trust is attached to the exact app binary. Asking Enigo to prompt
        // registers the currently running build, which fixes the common case
        // where System Settings still shows an older Indoor Voice copy as on.
        let settings = Settings {
            open_prompt_to_get_permissions: true,
            ..Settings::default()
        };
        let _ = Enigo::new(&settings);
        input_permission_granted()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

fn copy_bytes_to_clipboard(bytes: &[u8]) -> bool {
    #[cfg(target_os = "macos")]
    {
        let Ok(mut child) = Command::new("pbcopy")
            // GUI applications do not reliably inherit a UTF-8 locale. When
            // pbcopy falls back to MacRoman, a bullet becomes “‚Ä¢”. Pinning
            // the clipboard process to UTF-8 keeps bullets, Hebrew, smart
            // punctuation, and emoji intact.
            .env("LANG", "en_US.UTF-8")
            .env("LC_ALL", "en_US.UTF-8")
            .env("LC_CTYPE", "UTF-8")
            .stdin(Stdio::piped())
            .spawn()
        else {
            return false;
        };
        let wrote = child
            .stdin
            .take()
            .is_some_and(|mut input| input.write_all(bytes).is_ok());
        wrote && child.wait().is_ok_and(|status| status.success())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = bytes;
        false
    }
}

fn copy_to_clipboard(text: &str) -> bool {
    copy_bytes_to_clipboard(text.as_bytes())
}

fn read_text_clipboard() -> Option<Vec<u8>> {
    #[cfg(target_os = "macos")]
    {
        Command::new("pbpaste")
            .env("LANG", "en_US.UTF-8")
            .env("LC_ALL", "en_US.UTF-8")
            .env("LC_CTYPE", "UTF-8")
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| output.stdout)
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

fn paste_into_focused_app() -> bool {
    let settings = Settings {
        // Permission prompts belong to the explicit setup action. Repeatedly
        // prompting while inserting text makes every dictation feel broken.
        open_prompt_to_get_permissions: false,
        ..Settings::default()
    };
    match Enigo::new(&settings) {
        Ok(mut enigo) => {
            let pressed = enigo.key(Key::Meta, Direction::Press).is_ok();
            let pasted = pressed && enigo.key(Key::Unicode('v'), Direction::Click).is_ok();
            let released = enigo.key(Key::Meta, Direction::Release).is_ok();
            pasted && released
        }
        Err(_) => false,
    }
}

fn undo_in_focused_app() -> bool {
    let settings = Settings {
        open_prompt_to_get_permissions: false,
        ..Settings::default()
    };
    match Enigo::new(&settings) {
        Ok(mut enigo) => {
            let pressed = enigo.key(Key::Meta, Direction::Press).is_ok();
            let undone = pressed && enigo.key(Key::Unicode('z'), Direction::Click).is_ok();
            let released = enigo.key(Key::Meta, Direction::Release).is_ok();
            undone && released
        }
        Err(_) => false,
    }
}

fn should_insert_leading_space(previous: Option<char>, text: &str) -> bool {
    let Some(previous) = previous else {
        return false;
    };
    let Some(first) = text.chars().next() else {
        return false;
    };
    !previous.is_whitespace()
        && !matches!(previous, '(' | '[' | '{' | '/' | '\\' | '—' | '–')
        && !matches!(
            first,
            '.' | ',' | '?' | '!' | ';' | ':' | ')' | ']' | '}' | '…'
        )
}

#[cfg(target_os = "macos")]
fn character_before_cursor() -> Option<char> {
    use std::{ffi::c_void, os::raw::c_char, ptr};

    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;
    type AXUIElementRef = *const c_void;
    type AXValueRef = *const c_void;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct CFRange {
        location: isize,
        length: isize,
    }

    const AX_VALUE_CF_RANGE_TYPE: u32 = 4;
    const CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXUIElementCreateSystemWide() -> AXUIElementRef;
        fn AXUIElementCopyAttributeValue(
            element: AXUIElementRef,
            attribute: CFStringRef,
            value: *mut CFTypeRef,
        ) -> i32;
        fn AXUIElementCopyParameterizedAttributeValue(
            element: AXUIElementRef,
            attribute: CFStringRef,
            parameter: CFTypeRef,
            value: *mut CFTypeRef,
        ) -> i32;
        fn AXValueGetValue(value: AXValueRef, value_type: u32, value_ptr: *mut c_void) -> u8;
        fn AXValueCreate(value_type: u32, value_ptr: *const c_void) -> AXValueRef;
        fn CFStringGetCString(
            value: CFStringRef,
            buffer: *mut c_char,
            buffer_size: isize,
            encoding: u32,
        ) -> u8;
        fn CFStringCreateWithCString(
            allocator: CFTypeRef,
            value: *const c_char,
            encoding: u32,
        ) -> CFStringRef;
        fn CFRelease(value: CFTypeRef);
    }

    unsafe {
        let make_attribute = |name: &'static [u8]| {
            CFStringCreateWithCString(
                ptr::null(),
                name.as_ptr().cast::<c_char>(),
                CF_STRING_ENCODING_UTF8,
            )
        };
        let focused_attribute = make_attribute(b"AXFocusedUIElement\0");
        let selection_attribute = make_attribute(b"AXSelectedTextRange\0");
        let string_for_range_attribute = make_attribute(b"AXStringForRange\0");
        if focused_attribute.is_null()
            || selection_attribute.is_null()
            || string_for_range_attribute.is_null()
        {
            return None;
        }
        let system = AXUIElementCreateSystemWide();
        if system.is_null() {
            CFRelease(focused_attribute);
            CFRelease(selection_attribute);
            CFRelease(string_for_range_attribute);
            return None;
        }
        let mut focused: CFTypeRef = ptr::null();
        if AXUIElementCopyAttributeValue(system, focused_attribute, &mut focused) != 0
            || focused.is_null()
        {
            CFRelease(system);
            CFRelease(focused_attribute);
            CFRelease(selection_attribute);
            CFRelease(string_for_range_attribute);
            return None;
        }
        let mut selection_value: CFTypeRef = ptr::null();
        let selection_result =
            AXUIElementCopyAttributeValue(focused, selection_attribute, &mut selection_value);
        if selection_result != 0 || selection_value.is_null() {
            CFRelease(focused);
            CFRelease(system);
            CFRelease(focused_attribute);
            CFRelease(selection_attribute);
            CFRelease(string_for_range_attribute);
            return None;
        }
        let mut selection = CFRange::default();
        let has_range = AXValueGetValue(
            selection_value,
            AX_VALUE_CF_RANGE_TYPE,
            (&mut selection as *mut CFRange).cast(),
        ) != 0;
        CFRelease(selection_value);
        if !has_range || selection.length > 0 || selection.location <= 0 {
            CFRelease(focused);
            CFRelease(system);
            CFRelease(focused_attribute);
            CFRelease(selection_attribute);
            CFRelease(string_for_range_attribute);
            return None;
        }
        let previous_range = CFRange {
            location: selection.location - 1,
            length: 1,
        };
        let range_value = AXValueCreate(
            AX_VALUE_CF_RANGE_TYPE,
            (&previous_range as *const CFRange).cast(),
        );
        if range_value.is_null() {
            CFRelease(focused);
            CFRelease(system);
            CFRelease(focused_attribute);
            CFRelease(selection_attribute);
            CFRelease(string_for_range_attribute);
            return None;
        }
        let mut previous_string: CFTypeRef = ptr::null();
        let previous_result = AXUIElementCopyParameterizedAttributeValue(
            focused,
            string_for_range_attribute,
            range_value,
            &mut previous_string,
        );
        CFRelease(range_value);
        CFRelease(focused);
        CFRelease(system);
        CFRelease(focused_attribute);
        CFRelease(selection_attribute);
        CFRelease(string_for_range_attribute);
        if previous_result != 0 || previous_string.is_null() {
            return None;
        }
        let mut buffer = [0_i8; 16];
        let converted = CFStringGetCString(
            previous_string,
            buffer.as_mut_ptr(),
            buffer.len() as isize,
            CF_STRING_ENCODING_UTF8,
        ) != 0;
        CFRelease(previous_string);
        if !converted {
            return None;
        }
        let bytes = buffer
            .iter()
            .take_while(|value| **value != 0)
            .map(|value| *value as u8)
            .collect::<Vec<_>>();
        std::str::from_utf8(&bytes).ok()?.chars().next()
    }
}

#[cfg(not(target_os = "macos"))]
fn character_before_cursor() -> Option<char> {
    None
}

#[derive(Clone, Serialize)]
struct NativePillLevel {
    level: f32,
}

fn append_native_input<T: Copy>(
    data: &[T],
    convert: fn(T) -> f32,
    samples: &Arc<Mutex<Vec<f32>>>,
    maximum_samples: usize,
    app: &AppHandle,
    last_level_emit: &AtomicU64,
) {
    let mut energy = 0.0_f32;
    if let Ok(mut target) = samples.lock() {
        let available = maximum_samples.saturating_sub(target.len());
        for sample in data.iter().copied().take(available) {
            let value = convert(sample).clamp(-1.0, 1.0);
            energy += value * value;
            target.push(value);
        }
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let previous = last_level_emit.load(Ordering::Relaxed);
    if now.saturating_sub(previous) >= 55
        && last_level_emit
            .compare_exchange(previous, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
    {
        let divisor = data.len().max(1) as f32;
        let level = (energy / divisor).sqrt().mul_add(7.0, 0.0).clamp(0.0, 1.0);
        let _ = app.emit("pill-level", NativePillLevel { level });
    }
}

fn build_native_input_stream<T: cpal::SizedSample + Copy + Send + 'static>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    convert: fn(T) -> f32,
    samples: Arc<Mutex<Vec<f32>>>,
    error: Arc<Mutex<Option<String>>>,
    app: AppHandle,
    maximum_samples: usize,
) -> Result<cpal::Stream, String> {
    let callback_samples = samples;
    let callback_error = error.clone();
    let last_level_emit = Arc::new(AtomicU64::new(0));
    let callback_level_emit = last_level_emit;
    device
        .build_input_stream(
            config.clone(),
            move |data: &[T], _| {
                append_native_input(
                    data,
                    convert,
                    &callback_samples,
                    maximum_samples,
                    &app,
                    &callback_level_emit,
                );
            },
            move |stream_error| {
                if let Ok(mut state) = callback_error.lock() {
                    *state = Some(stream_error.to_string());
                }
            },
            None,
        )
        .map_err(|error| format!("The microphone stream could not start: {error}"))
}

fn input_devices() -> Result<Vec<AudioInputDevice>, String> {
    let host = cpal::default_host();
    let default_name = host
        .default_input_device()
        .and_then(|device| device.description().ok())
        .map(|description| description.name().to_owned());
    let devices = host
        .input_devices()
        .map_err(|error| format!("Microphone inputs could not be listed: {error}"))?
        .filter_map(|device| {
            device
                .description()
                .ok()
                .map(|description| description.name().to_owned())
        })
        .map(|name| AudioInputDevice {
            id: name.clone(),
            is_default: default_name.as_deref() == Some(name.as_str()),
            name,
        })
        .collect::<Vec<_>>();
    Ok(devices)
}

#[tauri::command]
pub fn list_audio_input_devices() -> Result<Vec<AudioInputDevice>, String> {
    input_devices()
}

#[tauri::command]
pub fn set_audio_input_device(
    recorder: State<'_, NativeAudioRecorder>,
    device_id: Option<String>,
) -> Result<(), String> {
    if recorder
        .0
        .lock()
        .map_err(|_| "The microphone recorder is unavailable.".to_string())?
        .is_some()
    {
        return Err("Stop the current recording before changing microphones.".into());
    }
    let selection = device_id.filter(|value| !value.trim().is_empty());
    if let Some(device_id) = selection.as_deref() {
        if !input_devices()?.iter().any(|device| device.id == device_id) {
            return Err("The selected microphone is no longer available.".into());
        }
    }
    *recorder
        .1
        .lock()
        .map_err(|_| "The microphone selection is unavailable.".to_string())? = selection;
    Ok(())
}

fn selected_input_device(recorder: &NativeAudioRecorder) -> Result<Option<String>, String> {
    recorder
        .1
        .lock()
        .map(|selection| selection.clone())
        .map_err(|_| "The microphone selection is unavailable.".to_string())
}

fn resolve_input_device(selection: Option<&str>) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if let Some(selection) = selection {
        return host
            .input_devices()
            .map_err(|error| format!("Microphone inputs could not be listed: {error}"))?
            .find(|device| {
                device
                    .description()
                    .ok()
                    .is_some_and(|description| description.name() == selection)
            })
            .ok_or_else(|| "The selected microphone is no longer available.".to_string());
    }
    host.default_input_device()
        .ok_or_else(|| "No microphone input device is available.".to_string())
}

fn diagnostic_report(
    app: &AppHandle,
    recorder: &NativeAudioRecorder,
    descriptor: &'static ModelDescriptor,
) -> Result<TranscriptionDiagnosticReport, String> {
    let input_devices = input_devices()?;
    let default_input_device = input_devices
        .iter()
        .find(|device| device.is_default)
        .map(|device| device.name.clone());
    let selected_input_device = selected_input_device(recorder)?;
    let (capture_active, capture_seconds, capture_error) = {
        let capture = recorder
            .0
            .lock()
            .map_err(|_| "The microphone recorder is unavailable.".to_string())?;
        match capture.as_ref() {
            Some(capture) => {
                let captured_samples = capture
                    .samples
                    .lock()
                    .map(|samples| samples.len())
                    .unwrap_or(0);
                (
                    true,
                    captured_samples as f32
                        / capture.channels.max(1) as f32
                        / capture.sample_rate.max(1) as f32,
                    capture.error.lock().ok().and_then(|error| error.clone()),
                )
            }
            None => (false, 0.0, None),
        }
    };
    let model = status_for_model(app, descriptor)?;
    let mut notes = Vec::new();
    if input_devices.is_empty() {
        notes.push("No microphone input is available.".into());
    }
    if let Some(selected) = selected_input_device.as_deref() {
        if !input_devices.iter().any(|device| device.id == selected) {
            notes.push("The selected microphone is disconnected.".into());
        }
    }
    if !model.ready {
        notes.push(format!(
            "The {} model is missing or failed its integrity check.",
            descriptor.profile
        ));
    }
    if capture_error.is_some() {
        notes.push("The active microphone stream reported an error.".into());
    }
    let ready = model.ready
        && !input_devices.is_empty()
        && capture_error.is_none()
        && selected_input_device.as_ref().map_or(true, |selected| {
            input_devices.iter().any(|device| &device.id == selected)
        });
    Ok(TranscriptionDiagnosticReport {
        ready,
        checked_at: now_millis(),
        backend: "whisper.cpp · CPU",
        supported_languages: ["auto", "en", "he", "en-he"],
        model,
        input_devices,
        selected_input_device,
        default_input_device,
        capture_active,
        capture_seconds,
        capture_error,
        accessibility_granted: input_permission_granted(),
        notes,
    })
}

#[tauri::command]
pub fn transcription_diagnostics(
    app: AppHandle,
    recorder: State<'_, NativeAudioRecorder>,
    profile: Option<String>,
) -> Result<TranscriptionDiagnosticReport, String> {
    diagnostic_report(
        &app,
        recorder.inner(),
        model_descriptor(profile.as_deref())?,
    )
}

#[tauri::command]
pub async fn run_transcription_self_test(
    app: AppHandle,
    recorder: State<'_, NativeAudioRecorder>,
    engine: State<'_, WhisperEngine>,
    profile: Option<String>,
) -> Result<TranscriptionDiagnosticReport, String> {
    let descriptor = model_descriptor(profile.as_deref())?;
    let report = diagnostic_report(&app, recorder.inner(), descriptor)?;
    if !report.model.ready {
        return Ok(report);
    }
    let model = model_path_for(&app, descriptor)?;
    let context = engine.context.clone();
    tauri::async_runtime::spawn_blocking(move || load_context(&context, &model).map(|_| ()))
        .await
        .map_err(|_| "The model self-test stopped unexpectedly.".to_string())??;
    let mut report = diagnostic_report(&app, recorder.inner(), descriptor)?;
    report.notes.push(
        "The verified model loaded successfully; no audio or transcript was retained.".into(),
    );
    Ok(report)
}

#[tauri::command]
pub fn start_audio_capture(
    app: AppHandle,
    recorder: State<'_, NativeAudioRecorder>,
) -> Result<(), String> {
    let selected_device = selected_input_device(recorder.inner())?;
    start_audio_capture_inner(app, recorder.inner(), selected_device.as_deref())
}

#[tauri::command]
pub fn start_audio_capture_with_device(
    app: AppHandle,
    recorder: State<'_, NativeAudioRecorder>,
    device_id: Option<String>,
) -> Result<(), String> {
    if recorder
        .0
        .lock()
        .map_err(|_| "The microphone recorder is unavailable.".to_string())?
        .is_some()
    {
        return Ok(());
    }
    if let Some(device_id) = device_id.filter(|value| !value.trim().is_empty()) {
        if !input_devices()?.iter().any(|device| device.id == device_id) {
            return Err("The selected microphone is no longer available.".into());
        }
        *recorder
            .1
            .lock()
            .map_err(|_| "The microphone selection is unavailable.".to_string())? = Some(device_id);
    }
    let selected_device = selected_input_device(recorder.inner())?;
    start_audio_capture_inner(app, recorder.inner(), selected_device.as_deref())
}

fn start_audio_capture_inner(
    app: AppHandle,
    recorder: &NativeAudioRecorder,
    device_id: Option<&str>,
) -> Result<(), String> {
    let mut active = recorder
        .0
        .lock()
        .map_err(|_| "The microphone recorder is unavailable.".to_string())?;
    if active.is_some() {
        return Ok(());
    }
    let device = resolve_input_device(device_id)?;
    let supported = device
        .default_input_config()
        .map_err(|error| format!("The default microphone format is unavailable: {error}"))?;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let samples = Arc::new(Mutex::new(Vec::new()));
    let error = Arc::new(Mutex::new(None));
    let maximum_samples =
        config.sample_rate as usize * config.channels as usize * MAX_RECORDING_SECONDS;
    let stream = match sample_format {
        cpal::SampleFormat::F32 => build_native_input_stream(
            &device,
            &config,
            |sample: f32| sample,
            samples.clone(),
            error.clone(),
            app,
            maximum_samples,
        )?,
        cpal::SampleFormat::I16 => build_native_input_stream(
            &device,
            &config,
            |sample: i16| sample as f32 / i16::MAX as f32,
            samples.clone(),
            error.clone(),
            app,
            maximum_samples,
        )?,
        cpal::SampleFormat::U16 => build_native_input_stream(
            &device,
            &config,
            |sample: u16| (sample as f32 / u16::MAX as f32) * 2.0 - 1.0,
            samples.clone(),
            error.clone(),
            app,
            maximum_samples,
        )?,
        _ => {
            return Err(format!(
                "The microphone sample format {sample_format} is unsupported."
            ))
        }
    };
    stream
        .play()
        .map_err(|error| format!("Microphone permission or playback failed: {error}"))?;
    *active = Some(NativeAudioCapture {
        stream,
        samples,
        error,
        sample_rate: config.sample_rate,
        channels: config.channels,
    });
    Ok(())
}

fn mono_resampled_audio(interleaved: &[f32], channels: u16, source_rate: u32) -> Vec<f32> {
    let channels = channels.max(1) as usize;
    let mono = interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect::<Vec<_>>();
    if source_rate == SAMPLE_RATE as u32 || mono.is_empty() {
        return mono;
    }
    let output_length = ((mono.len() as f64 * SAMPLE_RATE as f64) / source_rate as f64)
        .round()
        .max(1.0) as usize;
    (0..output_length)
        .map(|index| {
            let source_position = index as f64 * source_rate as f64 / SAMPLE_RATE as f64;
            let left = source_position.floor() as usize;
            let right = (left + 1).min(mono.len() - 1);
            let fraction = (source_position - left as f64) as f32;
            mono[left.min(mono.len() - 1)] * (1.0 - fraction) + mono[right] * fraction
        })
        .collect()
}

struct CapturedAudio {
    samples: Vec<f32>,
    captured_seconds: f32,
}

fn finish_native_capture(recorder: &NativeAudioRecorder) -> Result<CapturedAudio, String> {
    let capture = recorder
        .0
        .lock()
        .map_err(|_| "The microphone recorder is unavailable.".to_string())?
        .take()
        .ok_or_else(|| "No microphone recording is active.".to_string())?;
    let NativeAudioCapture {
        stream,
        samples,
        error,
        sample_rate,
        channels,
    } = capture;
    let _ = stream.pause();
    drop(stream);
    let stream_error = error.lock().ok().and_then(|state| state.clone());
    let interleaved = {
        let mut samples = samples
            .lock()
            .map_err(|_| "The microphone samples are unavailable.".to_string())?;
        std::mem::take(&mut *samples)
    };
    if interleaved.is_empty() {
        return Err(stream_error.unwrap_or_else(|| "The microphone returned no audio.".to_string()));
    }
    let captured_seconds =
        interleaved.len() as f32 / channels.max(1) as f32 / sample_rate.max(1) as f32;
    Ok(CapturedAudio {
        samples: mono_resampled_audio(&interleaved, channels, sample_rate),
        captured_seconds,
    })
}

#[tauri::command]
pub fn snapshot_audio_capture(
    recorder: State<'_, NativeAudioRecorder>,
) -> Result<NativeAudioResult, String> {
    let active = recorder
        .0
        .lock()
        .map_err(|_| "The microphone recorder is unavailable.".to_string())?;
    let capture = active
        .as_ref()
        .ok_or_else(|| "No microphone recording is active.".to_string())?;
    let interleaved = capture
        .samples
        .lock()
        .map_err(|_| "The microphone samples are unavailable.".to_string())?
        .clone();
    let captured_seconds = interleaved.len() as f32
        / capture.channels.max(1) as f32
        / capture.sample_rate.max(1) as f32;
    Ok(NativeAudioResult {
        samples: mono_resampled_audio(&interleaved, capture.channels, capture.sample_rate),
        captured_seconds,
    })
}

#[tauri::command]
pub fn snapshot_audio_capture_window(
    recorder: State<'_, NativeAudioRecorder>,
    seconds: Option<f32>,
) -> Result<NativeAudioResult, String> {
    snapshot_native_window(
        recorder.inner(),
        seconds.unwrap_or(LIVE_PREVIEW_SECONDS as f32),
    )
}

fn snapshot_native_window(
    recorder: &NativeAudioRecorder,
    seconds: f32,
) -> Result<NativeAudioResult, String> {
    let active = recorder
        .0
        .lock()
        .map_err(|_| "The microphone recorder is unavailable.".to_string())?;
    let capture = active
        .as_ref()
        .ok_or_else(|| "No microphone recording is active.".to_string())?;
    let samples = capture
        .samples
        .lock()
        .map_err(|_| "The microphone samples are unavailable.".to_string())?;
    let captured_seconds =
        samples.len() as f32 / capture.channels.max(1) as f32 / capture.sample_rate.max(1) as f32;
    let seconds = seconds.clamp(0.5, 30.0);
    let frames = (seconds * capture.sample_rate as f32).round() as usize;
    let wanted_samples = frames.saturating_mul(capture.channels.max(1) as usize);
    let mut start = samples.len().saturating_sub(wanted_samples);
    start -= start % capture.channels.max(1) as usize;
    let window = samples[start..].to_vec();
    drop(samples);
    Ok(NativeAudioResult {
        samples: mono_resampled_audio(&window, capture.channels, capture.sample_rate),
        captured_seconds,
    })
}

#[tauri::command]
pub fn stop_audio_capture(
    recorder: State<'_, NativeAudioRecorder>,
) -> Result<NativeAudioResult, String> {
    let capture = finish_native_capture(recorder.inner())?;
    Ok(NativeAudioResult {
        samples: capture.samples,
        captured_seconds: capture.captured_seconds,
    })
}

struct SpeechActivity {
    speech: Vec<f32>,
    speech_seconds: f32,
}

fn detect_speech_activity(samples: &[f32]) -> Option<SpeechActivity> {
    const FRAME_SIZE: usize = 320;
    const MINIMUM_RMS: f32 = 0.0038;
    const NOISE_RATIO: f32 = 1.8;
    const MINIMUM_PEAK: f32 = 0.012;
    const MINIMUM_RAW_FRAMES: usize = 6;
    const MINIMUM_CONTIGUOUS_RAW_FRAMES: usize = 4;
    const MINIMUM_EXPANDED_FRAMES: usize = 10;

    let frames = samples
        .chunks_exact(FRAME_SIZE)
        .map(|frame| {
            let energy = frame.iter().map(|sample| sample * sample).sum::<f32>();
            let peak = frame
                .iter()
                .fold(0.0_f32, |maximum, sample| maximum.max(sample.abs()));
            ((energy / FRAME_SIZE as f32).sqrt(), peak)
        })
        .collect::<Vec<_>>();
    if frames.is_empty() {
        return None;
    }
    let mut ordered_rms = frames.iter().map(|frame| frame.0).collect::<Vec<_>>();
    ordered_rms.sort_by(f32::total_cmp);
    let noise_floor = ordered_rms[((ordered_rms.len() - 1) as f32 * 0.15) as usize];
    let threshold = MINIMUM_RMS.max(noise_floor * NOISE_RATIO);
    let raw_activity = frames
        .iter()
        .map(|(rms, peak)| *rms >= threshold && *peak >= MINIMUM_PEAK)
        .collect::<Vec<_>>();
    let raw_active_frames = raw_activity.iter().filter(|active| **active).count();
    let longest_raw_run = raw_activity
        .iter()
        .fold((0_usize, 0_usize), |(current, longest), active| {
            let current = if *active { current + 1 } else { 0 };
            (current, longest.max(current))
        })
        .1;
    let activity = raw_activity
        .iter()
        .enumerate()
        .map(|(index, _)| {
            let start = index.saturating_sub(2);
            let end = (index + 2).min(raw_activity.len() - 1);
            raw_activity[start..=end]
                .iter()
                .filter(|active| **active)
                .count()
                >= 2
        })
        .collect::<Vec<_>>();
    let active_indices = activity
        .iter()
        .enumerate()
        .filter_map(|(index, active)| active.then_some(index))
        .collect::<Vec<_>>();
    let first_frame = *active_indices.first()?;
    let last_frame = *active_indices.last()?;
    let speech_span_frames = last_frame - first_frame + 1;
    let has_speech = raw_active_frames >= MINIMUM_RAW_FRAMES
        && longest_raw_run >= MINIMUM_CONTIGUOUS_RAW_FRAMES
        && active_indices.len() >= MINIMUM_EXPANDED_FRAMES
        && speech_span_frames >= 12
        && frames.iter().any(|frame| frame.1 >= MINIMUM_PEAK * 1.25);
    if !has_speech {
        return None;
    }
    let padded_start = first_frame.saturating_sub(10) * FRAME_SIZE;
    let padded_end = ((last_frame + 16) * FRAME_SIZE).min(samples.len());
    Some(SpeechActivity {
        speech: samples[padded_start..padded_end].to_vec(),
        speech_seconds: raw_active_frames as f32 * FRAME_SIZE as f32 / SAMPLE_RATE as f32,
    })
}

fn record_transcription_failure(storage: &Arc<Mutex<Option<TranscriptionFailure>>>, message: &str) {
    let (stage, code, retryable) = if message == "Transcription canceled." {
        ("cancellation", "canceled", true)
    } else if message.contains("encoder error (-6)") {
        ("inference", "whisper_encoder_-6", true)
    } else if message.contains("model") {
        ("model", "model_unavailable", true)
    } else if message.contains("speech") || message.contains("recording") {
        ("audio", "invalid_or_silent_audio", true)
    } else {
        ("inference", "transcription_failed", true)
    };
    if let Ok(mut failure) = storage.lock() {
        *failure = Some(TranscriptionFailure {
            stage,
            code,
            message: message.to_owned(),
            retryable,
        });
    }
}

#[tauri::command]
pub fn last_transcription_failure(
    engine: State<'_, WhisperEngine>,
) -> Option<TranscriptionFailure> {
    engine
        .last_failure
        .lock()
        .ok()
        .and_then(|failure| failure.clone())
}

#[tauri::command]
pub async fn transcribe_audio(
    app: AppHandle,
    engine: State<'_, WhisperEngine>,
    request: TranscribeRequest,
) -> Result<TranscriptionResult, String> {
    if let Err(message) = validate_samples(&request.samples) {
        record_transcription_failure(&engine.last_failure, &message);
        return Err(message);
    }
    let descriptor = match model_descriptor(request.profile.as_deref()) {
        Ok(descriptor) => descriptor,
        Err(message) => {
            record_transcription_failure(&engine.last_failure, &message);
            return Err(message);
        }
    };
    let model = model_path_for(&app, descriptor)?;
    if !verify_model_file(&model, descriptor) {
        let message = "The local Whisper model is missing or failed its integrity check.";
        record_transcription_failure(&engine.last_failure, message);
        return Err(message.into());
    }
    let recordings = recordings_dir(&app)?;
    let samples = request.samples;
    let samples_for_transcription = samples.clone();
    let language = request.language;
    let context = engine.context.clone();
    let inference = engine.inference.clone();
    let cancellation = engine.cancellation.clone();
    let last_failure = engine.last_failure.clone();
    let generation = cancellation.load(Ordering::Acquire);
    let text_result = tauri::async_runtime::spawn_blocking(move || {
        transcribe_samples(
            context,
            inference,
            &model,
            &samples_for_transcription,
            language.as_deref(),
            Some((cancellation, generation)),
            false,
        )
    })
    .await
    .map_err(|_| "The local transcription task stopped unexpectedly.".to_string())?;
    let text = match text_result {
        Ok(text) => {
            if let Ok(mut failure) = last_failure.lock() {
                *failure = None;
            }
            text
        }
        Err(message) => {
            record_transcription_failure(&last_failure, &message);
            return Err(message);
        }
    };
    let recording = if request.save_recording {
        Some(save_recording(&recordings, &samples, &text)?)
    } else {
        None
    };
    let duration = samples.len() as f32 / SAMPLE_RATE as f32;
    Ok(TranscriptionResult {
        text,
        recording,
        captured_seconds: duration,
        speech_seconds: duration,
    })
}

#[tauri::command]
pub async fn preview_transcription(
    app: AppHandle,
    engine: State<'_, WhisperEngine>,
    request: TranscribeRequest,
) -> Result<TranscriptionResult, String> {
    validate_samples(&request.samples)?;
    let descriptor = model_descriptor(request.profile.as_deref())?;
    let model = model_path_for(&app, descriptor)?;
    if !verify_model_file(&model, descriptor) {
        return Err("The local Whisper model is missing or failed its integrity check.".into());
    }
    let samples = request.samples;
    let duration = samples.len() as f32 / SAMPLE_RATE as f32;
    let language = request.language;
    let context = engine.context.clone();
    let inference = engine.inference.clone();
    let cancellation = engine.cancellation.clone();
    let generation = cancellation.load(Ordering::Acquire);
    let text = tauri::async_runtime::spawn_blocking(move || {
        transcribe_samples(
            context,
            inference,
            &model,
            &samples,
            language.as_deref(),
            Some((cancellation, generation)),
            true,
        )
    })
    .await
    .map_err(|_| "The live transcription task stopped unexpectedly.".to_string())??;
    Ok(TranscriptionResult {
        text,
        recording: None,
        captured_seconds: duration,
        speech_seconds: duration,
    })
}

#[tauri::command]
pub async fn preview_active_capture(
    app: AppHandle,
    recorder: State<'_, NativeAudioRecorder>,
    engine: State<'_, WhisperEngine>,
    language: Option<String>,
    profile: Option<String>,
) -> Result<TranscriptionResult, String> {
    let capture = snapshot_native_window(recorder.inner(), LIVE_PREVIEW_SECONDS as f32)?;
    let activity = detect_speech_activity(&capture.samples)
        .ok_or_else(|| "No speech was detected in the live preview window.".to_string())?;
    if let Err(message) = validate_samples(&activity.speech) {
        record_transcription_failure(&engine.last_failure, &message);
        return Err(message);
    }
    let descriptor = model_descriptor(profile.as_deref())?;
    let model = model_path_for(&app, descriptor)?;
    if !verify_model_file(&model, descriptor) {
        return Err("The local Whisper model is missing or failed its integrity check.".into());
    }
    let context = engine.context.clone();
    let inference = engine.inference.clone();
    let cancellation = engine.cancellation.clone();
    let generation = cancellation.load(Ordering::Acquire);
    let speech = activity.speech;
    let text = tauri::async_runtime::spawn_blocking(move || {
        transcribe_samples(
            context,
            inference,
            &model,
            &speech,
            language.as_deref(),
            Some((cancellation, generation)),
            true,
        )
    })
    .await
    .map_err(|_| "The live transcription task stopped unexpectedly.".to_string())??;
    Ok(TranscriptionResult {
        text,
        recording: None,
        captured_seconds: capture.captured_seconds,
        speech_seconds: activity.speech_seconds,
    })
}

#[tauri::command]
pub async fn stop_and_transcribe_audio(
    app: AppHandle,
    recorder: State<'_, NativeAudioRecorder>,
    engine: State<'_, WhisperEngine>,
    request: NativeTranscribeRequest,
) -> Result<TranscriptionResult, String> {
    // Invalidate any live preview generation before taking the final buffer.
    // whisper-rs' abort callback is unsafe in the current binding, so an
    // already-running preview finishes safely while no stale queued preview
    // can run after this final request.
    let generation = engine.cancellation.fetch_add(1, Ordering::AcqRel) + 1;
    let capture = finish_native_capture(recorder.inner())?;
    let activity = match detect_speech_activity(&capture.samples) {
        Some(activity) => activity,
        None => {
            let message =
                "No speech was detected. Silence and steady background noise were ignored.";
            record_transcription_failure(&engine.last_failure, message);
            return Err(message.into());
        }
    };
    if let Err(message) = validate_samples(&activity.speech) {
        record_transcription_failure(&engine.last_failure, &message);
        return Err(message);
    }
    let descriptor = match model_descriptor(request.profile.as_deref()) {
        Ok(descriptor) => descriptor,
        Err(message) => {
            record_transcription_failure(&engine.last_failure, &message);
            return Err(message);
        }
    };
    let model = model_path_for(&app, descriptor)?;
    if !verify_model_file(&model, descriptor) {
        let message = "The local Whisper model is missing or failed its integrity check.";
        record_transcription_failure(&engine.last_failure, message);
        return Err(message.into());
    }
    let recordings = recordings_dir(&app)?;
    let samples = activity.speech;
    let samples_for_transcription = samples.clone();
    let language = request.language;
    let context = engine.context.clone();
    let inference = engine.inference.clone();
    let cancellation = engine.cancellation.clone();
    let last_failure = engine.last_failure.clone();
    let text_result = tauri::async_runtime::spawn_blocking(move || {
        transcribe_samples(
            context,
            inference,
            &model,
            &samples_for_transcription,
            language.as_deref(),
            Some((cancellation, generation)),
            false,
        )
    })
    .await
    .map_err(|_| "The local transcription task stopped unexpectedly.".to_string())?;
    let text = match text_result {
        Ok(text) => {
            if let Ok(mut failure) = last_failure.lock() {
                *failure = None;
            }
            text
        }
        Err(message) => {
            record_transcription_failure(&last_failure, &message);
            return Err(message);
        }
    };
    let recording = if request.save_recording {
        Some(save_recording(&recordings, &samples, &text)?)
    } else {
        None
    };
    Ok(TranscriptionResult {
        text,
        recording,
        captured_seconds: capture.captured_seconds,
        speech_seconds: activity.speech_seconds,
    })
}

#[tauri::command]
pub fn cancel_transcription(engine: State<'_, WhisperEngine>) -> bool {
    engine.cancellation.fetch_add(1, Ordering::AcqRel);
    true
}

fn valid_recording_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 32 && id.chars().all(|character| character.is_ascii_digit())
}

#[tauri::command]
pub fn list_recordings(app: AppHandle) -> Result<Vec<RecordingEntry>, String> {
    let directory = recordings_dir(&app)?;
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut recordings = fs::read_dir(directory)
        .map_err(|_| "The recording archive could not be read.".to_string())?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("json"))
        .filter_map(|entry| fs::read(entry.path()).ok())
        .filter_map(|bytes| serde_json::from_slice::<RecordingEntry>(&bytes).ok())
        .collect::<Vec<_>>();
    recordings.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(recordings)
}

#[tauri::command]
pub fn load_recording_audio(app: AppHandle, id: String) -> Result<String, String> {
    if !valid_recording_id(&id) {
        return Err("The recording identifier is invalid.".into());
    }
    let path = recordings_dir(&app)?.join(format!("{id}.wav"));
    let metadata = path
        .metadata()
        .map_err(|_| "The recording audio was not found.".to_string())?;
    if metadata.len() > 8 * 1024 * 1024 {
        return Err("The recording audio is larger than the playback limit.".into());
    }
    let bytes = fs::read(path).map_err(|_| "The recording audio could not be read.".to_string())?;
    Ok(format!("data:audio/wav;base64,{}", BASE64.encode(bytes)))
}

#[tauri::command]
pub fn insert_text(text: String, smart_spacing: bool) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() || text.chars().count() > 20_000 {
        return Err("The text is empty or too long to insert.".into());
    }
    let insertion = if smart_spacing && should_insert_leading_space(character_before_cursor(), text)
    {
        format!(" {text}")
    } else {
        text.to_owned()
    };
    let previous_clipboard = read_text_clipboard();
    if !copy_to_clipboard(&insertion) {
        return Err("The transcript could not be copied to the clipboard.".into());
    }
    if !input_permission_granted() {
        return Err("Text copied to the clipboard. Turn on Indoor Voice in System Settings → Privacy & Security → Accessibility, then press ⌘V this time.".into());
    }
    if paste_into_focused_app() {
        LAST_INSERTION_AT_MS.store(now_millis(), Ordering::Release);
        if let Some(previous_clipboard) = previous_clipboard {
            // Most macOS editors read the pasteboard synchronously on Cmd-V.
            // A short delay preserves the user's text clipboard without
            // racing the destination app's paste handler.
            thread::sleep(Duration::from_millis(CLIPBOARD_RESTORE_DELAY_MS));
            let _ = copy_bytes_to_clipboard(&previous_clipboard);
        }
        Ok(())
    } else {
        Err("Text copied to the clipboard, but macOS blocked ⌘V. Re-enable Indoor Voice in Accessibility, then press ⌘V this time.".into())
    }
}

#[tauri::command]
pub fn undo_last_insertion() -> Result<(), String> {
    let inserted_at = LAST_INSERTION_AT_MS.load(Ordering::Acquire);
    if inserted_at == 0 || now_millis().saturating_sub(inserted_at) > UNDO_WINDOW_MS {
        return Err("There is no recent Indoor Voice insertion to undo.".into());
    }
    if !input_permission_granted() {
        return Err("Turn on Indoor Voice in System Settings → Privacy & Security → Accessibility before undoing the insertion.".into());
    }
    if undo_in_focused_app() {
        LAST_INSERTION_AT_MS.store(0, Ordering::Release);
        Ok(())
    } else {
        Err("macOS blocked Undo. Return to the app where text was inserted and press ⌘Z.".into())
    }
}

#[tauri::command]
pub fn update_recording_transcript(
    app: AppHandle,
    id: String,
    transcript: String,
) -> Result<RecordingEntry, String> {
    if !valid_recording_id(&id) {
        return Err("The recording identifier is invalid.".into());
    }
    let transcript = transcript.trim();
    if transcript.is_empty() || transcript.chars().count() > 20_000 {
        return Err("The updated transcript is empty or too long.".into());
    }
    let path = recordings_dir(&app)?.join(format!("{id}.json"));
    let bytes = fs::read(&path).map_err(|_| "The recording metadata was not found.".to_string())?;
    let mut recording: RecordingEntry = serde_json::from_slice(&bytes)
        .map_err(|_| "The recording metadata could not be read.".to_string())?;
    recording.transcript = transcript.to_owned();
    recording.words = transcript.split_whitespace().count();
    recording.title = transcript
        .split_whitespace()
        .take(6)
        .collect::<Vec<_>>()
        .join(" ");
    let metadata = serde_json::to_vec(&recording)
        .map_err(|_| "The recording metadata could not be encoded.".to_string())?;
    fs::write(path, metadata)
        .map_err(|_| "The recording metadata could not be updated.".to_string())?;
    Ok(recording)
}

#[tauri::command]
pub fn delete_recording(app: AppHandle, id: String) -> Result<(), String> {
    if !valid_recording_id(&id) {
        return Err("The recording identifier is invalid.".into());
    }
    let directory = recordings_dir(&app)?;
    for extension in ["wav", "json"] {
        let path = directory.join(format!("{id}.{extension}"));
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("The recording could not be deleted.".into()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_validation_limits_duration_and_values() {
        let voiced = (0..SAMPLE_RATE)
            .map(|index| if index % 2 == 0 { 0.03 } else { -0.03 })
            .collect::<Vec<_>>();
        assert!(validate_samples(&voiced).is_ok());
        assert!(validate_samples(&vec![0.0; SAMPLE_RATE]).is_err());
        assert!(validate_samples(&vec![0.0; 20]).is_err());
        assert!(validate_samples(&vec![0.0; SAMPLE_RATE * (MAX_RECORDING_SECONDS + 1)]).is_err());
        let mut invalid = vec![0.0; SAMPLE_RATE];
        invalid[100] = f32::NAN;
        assert!(validate_samples(&invalid).is_err());
    }

    #[test]
    fn whisper_encoder_errors_are_identified_for_retry() {
        assert!(is_encoder_failure(&WhisperError::GenericError(-6)));
        assert!(is_encoder_failure(&WhisperError::FailedToEncode));
        assert!(!is_encoder_failure(&WhisperError::GenericError(-5)));
    }

    #[test]
    fn recording_ids_cannot_escape_the_archive() {
        assert!(valid_recording_id("1700000000000"));
        assert!(!valid_recording_id("../private"));
        assert!(!valid_recording_id("recording-1"));
    }

    #[test]
    fn smart_spacing_only_separates_adjacent_words_and_sentences() {
        assert!(should_insert_leading_space(Some('.'), "Next sentence"));
        assert!(should_insert_leading_space(Some('o'), "world"));
        assert!(should_insert_leading_space(Some(')'), "Continue"));
        assert!(!should_insert_leading_space(Some(' '), "Already spaced"));
        assert!(!should_insert_leading_space(None, "Beginning"));
        assert!(!should_insert_leading_space(Some('('), "inside"));
        assert!(!should_insert_leading_space(Some('d'), ", continued"));
    }

    #[test]
    fn native_capture_downmixes_and_resamples_to_whisper_audio() {
        let stereo = vec![1.0, -1.0, 0.5, 0.5, -0.5, -0.5, 0.0, 0.0];
        let mono = mono_resampled_audio(&stereo, 2, SAMPLE_RATE as u32);
        assert_eq!(mono, vec![0.0, 0.5, -0.5, 0.0]);

        let doubled = mono_resampled_audio(&[0.0, 1.0], 1, (SAMPLE_RATE / 2) as u32);
        assert_eq!(doubled.len(), 4);
        assert_eq!(doubled[0], 0.0);
        assert_eq!(doubled[1], 0.5);
        assert_eq!(doubled[2], 1.0);
    }

    #[test]
    fn bilingual_mode_is_accepted_as_automatic_detection() {
        let error = transcribe_samples(
            WhisperEngine::default().context,
            Arc::new(Mutex::new(())),
            Path::new("/missing/model.bin"),
            &[0.0; SAMPLE_RATE],
            Some("en-he"),
            None,
            false,
        )
        .expect_err("missing model should fail after accepting bilingual mode");
        assert_ne!(error, "Choose a supported dictation language.");

        let unsupported = transcribe_samples(
            WhisperEngine::default().context,
            Arc::new(Mutex::new(())),
            Path::new("/missing/model.bin"),
            &[0.0; SAMPLE_RATE],
            Some("unsupported"),
            None,
            false,
        )
        .expect_err("unknown language should be rejected");
        assert_eq!(unsupported, "Choose a supported dictation language.");
    }

    #[test]
    fn bilingual_detection_compares_only_english_and_hebrew() {
        let mut probabilities = vec![0.0; whisper_rs::get_lang_max_id() as usize + 1];
        probabilities[get_lang_id("en").expect("English language id") as usize] = 0.31;
        probabilities[get_lang_id("he").expect("Hebrew language id") as usize] = 0.42;
        assert_eq!(english_or_hebrew(&probabilities), "he");
        probabilities[get_lang_id("en").expect("English language id") as usize] = 0.73;
        assert_eq!(english_or_hebrew(&probabilities), "en");
    }

    #[test]
    fn model_profiles_are_fixed_https_artifacts_with_unique_files() {
        let mut files = std::collections::HashSet::new();
        for descriptor in MODEL_PROFILES {
            assert!(descriptor.url.starts_with("https://huggingface.co/"));
            assert_eq!(descriptor.sha256.len(), 64);
            assert!(descriptor.bytes > 100_000_000);
            assert!(files.insert(descriptor.file));
        }
        assert_eq!(model_descriptor(None).expect("default").profile, "fast");
        assert_eq!(
            model_descriptor(Some("balanced")).expect("balanced").file,
            "ggml-small.bin"
        );
        assert_eq!(
            model_descriptor(Some("best")).expect("best").file,
            "ggml-medium.bin"
        );
        assert!(model_descriptor(Some("unknown")).is_err());
    }

    #[test]
    fn native_speech_detection_trims_silence_and_reports_active_time() {
        let mut samples = vec![0.0; SAMPLE_RATE / 2];
        samples.extend((0..SAMPLE_RATE / 2).map(|index| if index % 2 == 0 { 0.04 } else { -0.04 }));
        samples.extend(vec![0.0; SAMPLE_RATE / 2]);
        let activity = detect_speech_activity(&samples).expect("voiced center should be detected");
        assert!(activity.speech.len() < samples.len());
        assert!(activity.speech_seconds > 0.35);
        assert!(activity.speech_seconds < 0.7);
        assert!(detect_speech_activity(&vec![0.0; SAMPLE_RATE]).is_none());
    }

    #[test]
    fn native_speech_detection_rejects_short_and_scattered_knocks() {
        const FRAME_SIZE: usize = 320;
        let mut short_knock = vec![0.0; SAMPLE_RATE];
        for (index, sample) in short_knock[FRAME_SIZE * 12..FRAME_SIZE * 15]
            .iter_mut()
            .enumerate()
        {
            *sample = if index % 2 == 0 { 0.08 } else { -0.08 };
        }
        assert!(detect_speech_activity(&short_knock).is_none());

        let mut scattered_knocks = vec![0.0; SAMPLE_RATE];
        for frame in [4_usize, 9, 14, 19, 24, 29, 34] {
            for (index, sample) in scattered_knocks[frame * FRAME_SIZE..(frame + 1) * FRAME_SIZE]
                .iter_mut()
                .enumerate()
            {
                *sample = if index % 2 == 0 { 0.08 } else { -0.08 };
            }
        }
        assert!(detect_speech_activity(&scattered_knocks).is_none());
    }

    #[test]
    fn structured_failures_do_not_include_audio_or_transcripts() {
        let storage = Arc::new(Mutex::new(None));
        record_transcription_failure(
            &storage,
            "Whisper encoder error (-6) after a safe CPU retry.",
        );
        let failure = storage
            .lock()
            .expect("failure lock")
            .clone()
            .expect("failure");
        let json = serde_json::to_value(failure).expect("failure serializes");
        assert_eq!(json["stage"], "inference");
        assert_eq!(json["code"], "whisper_encoder_-6");
        assert_eq!(json["retryable"], true);
        assert!(json.get("samples").is_none());
        assert!(json.get("transcript").is_none());
    }

    #[test]
    fn whisper_transcribes_a_known_sample_when_fixture_paths_are_set() {
        let Ok(model) = std::env::var("INDOOR_VOICE_TEST_MODEL") else {
            return;
        };
        let Ok(audio) = std::env::var("INDOOR_VOICE_TEST_AUDIO") else {
            return;
        };
        let mut reader = hound::WavReader::open(audio).expect("test WAV should open");
        assert_eq!(reader.spec().sample_rate, SAMPLE_RATE as u32);
        assert_eq!(reader.spec().channels, 1);
        let samples = reader
            .samples::<i16>()
            .map(|sample| sample.expect("valid PCM") as f32 / i16::MAX as f32)
            .collect::<Vec<_>>();
        let engine = WhisperEngine::default();
        let transcript = transcribe_samples(
            engine.context,
            engine.inference,
            Path::new(&model),
            &samples,
            Some("en-he"),
            None,
            false,
        )
        .expect("known speech should transcribe");
        let normalized = transcript.to_lowercase();
        assert!(normalized.contains("fellow americans"), "{transcript}");
    }
}
