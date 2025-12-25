use wasm_bindgen::prelude::*;
use image::{io::Reader as ImageReader, ImageFormat};
use std::io::Cursor;

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

/// Preprocess image data by resizing to target dimensions using high-quality Lanczos3 filtering
/// Returns preprocessed image data as RGBA bytes
/// This is a building block for ML/AI preprocessing pipelines
/// Note: source_width and source_height are kept for API compatibility but dimensions are determined from decoded image
#[wasm_bindgen]
pub fn preprocess_image(
    image_data: &[u8],
    _source_width: u32,
    _source_height: u32,
    target_width: u32,
    target_height: u32,
) -> Result<Vec<u8>, JsValue> {
    // Decode image from bytes (supports PNG and JPEG)
    // Try PNG first, then JPEG
    let img = ImageReader::with_format(Cursor::new(image_data), ImageFormat::Png)
        .decode()
        .or_else(|_| {
            ImageReader::with_format(Cursor::new(image_data), ImageFormat::Jpeg)
                .decode()
        })
        .map_err(|e| JsValue::from_str(&format!("Failed to decode image: {}", e)))?;

    // Resize using Lanczos3 filter for high-quality resizing
    // Lanczos3 provides excellent quality for ML model preprocessing
    let resized_img = img.resize_exact(target_width, target_height, image::imageops::FilterType::Lanczos3);

    // Convert to RGBA format
    let rgba_img = resized_img.to_rgba8();
    
    // Return as Vec<u8> (RGBA bytes)
    Ok(rgba_img.into_raw())
}

/// Simple text tokenization - converts text to token IDs
/// This is a placeholder implementation. In production, you'd use
/// a proper tokenizer that matches your model's vocabulary.
#[wasm_bindgen]
pub fn preprocess_text(text: &str) -> Vec<u32> {
    // Simple word-based tokenization
    // In production, use a proper tokenizer (e.g., tiktoken, sentencepiece)
    text.split_whitespace()
        .enumerate()
        .map(|(idx, _)| idx as u32 + 1) // Simple sequential token IDs
        .collect()
}

/// Normalize text input - lowercase, trim, remove extra whitespace
#[wasm_bindgen]
pub fn normalize_text(text: &str) -> String {
    text.trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ")
}

/// Get preprocessing statistics
#[wasm_bindgen]
pub fn get_preprocess_stats(
    original_size: u32,
    target_size: u32,
) -> PreprocessStats {
    PreprocessStats {
        original_size,
        target_size,
        scale_factor: target_size as f64 / original_size as f64,
    }
}

#[wasm_bindgen]
pub struct PreprocessStats {
    pub original_size: u32,
    pub target_size: u32,
    pub scale_factor: f64,
}

