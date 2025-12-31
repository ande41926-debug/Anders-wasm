use wasm_bindgen::prelude::*;
use serde::{Deserialize, Serialize};

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextStats {
    pub word_count: u32,
    pub character_count: u32,
    pub character_count_no_spaces: u32,
    pub sentence_count: u32,
    pub average_word_length: f64,
}

/// Detect language from text using simple heuristics
/// Returns language code: en, de, fr, it, pt, hi, es, th
#[wasm_bindgen]
pub fn detect_language(text: &str) -> String {
    if text.trim().is_empty() {
        return String::from("en");
    }

    let text_lower = text.to_lowercase();
    let words: Vec<&str> = text_lower.split_whitespace().collect();
    
    if words.is_empty() {
        return String::from("en");
    }

    let mut scores: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    
    // English common words
    let en_words = ["the", "be", "to", "of", "and", "a", "in", "that", "have", "i", "it", "for", "not", "on", "with", "he", "as", "you", "do", "at"];
    // German common words
    let de_words = ["der", "die", "und", "in", "den", "von", "zu", "das", "mit", "sich", "des", "auf", "für", "ist", "im", "dem", "nicht", "ein", "eine", "als"];
    // French common words
    let fr_words = ["le", "de", "et", "à", "un", "il", "être", "et", "en", "avoir", "que", "pour", "dans", "ce", "son", "une", "sur", "avec", "ne", "se"];
    // Italian common words
    let it_words = ["il", "di", "e", "la", "a", "un", "per", "è", "in", "una", "sono", "che", "si", "con", "non", "le", "da", "al", "i", "come"];
    // Portuguese common words
    let pt_words = ["o", "de", "e", "do", "da", "em", "um", "para", "é", "com", "não", "uma", "os", "no", "se", "na", "por", "mais", "as", "como"];
    // Hindi common words (transliterated)
    let hi_words = ["है", "और", "के", "में", "को", "से", "का", "की", "यह", "वह", "हो", "नहीं", "तो", "भी", "या", "पर", "इस", "उस", "जो", "कि"];
    // Spanish common words
    let es_words = ["el", "la", "de", "que", "y", "a", "en", "un", "ser", "se", "no", "haber", "por", "con", "su", "para", "como", "estar", "tener", "le"];
    // Thai common words
    let th_words = ["ที่", "เป็น", "และ", "ใน", "ของ", "จะ", "ได้", "ไม่", "มี", "ก็", "แล้ว", "กับ", "ให้", "ไป", "มา", "นี้", "นั้น", "เขา", "เธอ", "เรา"];

    // Score based on common words
    for word in words.iter().take(50) {
        let word_trimmed = word.trim_matches(|c: char| !c.is_alphanumeric());
        if word_trimmed.is_empty() {
            continue;
        }

        if en_words.contains(&word_trimmed) {
            *scores.entry(String::from("en")).or_insert(0) += 2;
        }
        if de_words.contains(&word_trimmed) {
            *scores.entry(String::from("de")).or_insert(0) += 2;
        }
        if fr_words.contains(&word_trimmed) {
            *scores.entry(String::from("fr")).or_insert(0) += 2;
        }
        if it_words.contains(&word_trimmed) {
            *scores.entry(String::from("it")).or_insert(0) += 2;
        }
        if pt_words.contains(&word_trimmed) {
            *scores.entry(String::from("pt")).or_insert(0) += 2;
        }
        if hi_words.contains(&word_trimmed) {
            *scores.entry(String::from("hi")).or_insert(0) += 3;
        }
        if es_words.contains(&word_trimmed) {
            *scores.entry(String::from("es")).or_insert(0) += 2;
        }
        if th_words.contains(&word_trimmed) {
            *scores.entry(String::from("th")).or_insert(0) += 3;
        }
    }

    // Character-based heuristics
    let _has_cyrillic = text.chars().any(|c| matches!(c, '\u{0400}'..='\u{04FF}'));
    let _has_arabic = text.chars().any(|c| matches!(c, '\u{0600}'..='\u{06FF}'));
    let has_devanagari = text.chars().any(|c| matches!(c, '\u{0900}'..='\u{097F}'));
    let has_thai = text.chars().any(|c| matches!(c, '\u{0E00}'..='\u{0E7F}'));
    
    if has_devanagari {
        *scores.entry(String::from("hi")).or_insert(0) += 10;
    }
    if has_thai {
        *scores.entry(String::from("th")).or_insert(0) += 10;
    }

    // Diacritics hint at Romance languages
    let has_french_diacritics = text.chars().any(|c| matches!(c, 'à' | 'â' | 'é' | 'è' | 'ê' | 'ë' | 'î' | 'ï' | 'ô' | 'ù' | 'û' | 'ü' | 'ÿ' | 'ç'));
    let has_spanish_diacritics = text.chars().any(|c| matches!(c, 'á' | 'é' | 'í' | 'ó' | 'ú' | 'ñ' | 'ü'));
    let has_portuguese_diacritics = text.chars().any(|c| matches!(c, 'á' | 'à' | 'â' | 'ã' | 'é' | 'ê' | 'í' | 'ó' | 'ô' | 'õ' | 'ú' | 'ü' | 'ç'));
    let has_italian_diacritics = text.chars().any(|c| matches!(c, 'à' | 'è' | 'é' | 'ì' | 'ò' | 'ù'));

    if has_french_diacritics {
        *scores.entry(String::from("fr")).or_insert(0) += 3;
    }
    if has_spanish_diacritics {
        *scores.entry(String::from("es")).or_insert(0) += 3;
    }
    if has_portuguese_diacritics {
        *scores.entry(String::from("pt")).or_insert(0) += 3;
    }
    if has_italian_diacritics {
        *scores.entry(String::from("it")).or_insert(0) += 3;
    }

    // German-specific characters
    let has_german_chars = text.chars().any(|c| matches!(c, 'ä' | 'ö' | 'ü' | 'ß'));
    if has_german_chars {
        *scores.entry(String::from("de")).or_insert(0) += 5;
    }

    // Find language with highest score
    let detected = scores.iter()
        .max_by_key(|(_, score)| *score)
        .map(|(lang, _)| lang.clone())
        .unwrap_or_else(|| String::from("en"));

    detected
}

/// Get text statistics
/// Returns JSON string with word count, character count, etc.
#[wasm_bindgen]
pub fn get_text_stats(text: &str) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    let word_count = words.len() as u32;
    
    let character_count = text.chars().count() as u32;
    let character_count_no_spaces = text.chars().filter(|c| !c.is_whitespace()).count() as u32;
    
    let sentence_count = text.split(|c: char| c == '.' || c == '!' || c == '?')
        .filter(|s| !s.trim().is_empty())
        .count() as u32;
    
    let total_word_length: u32 = words.iter()
        .map(|w| w.chars().count() as u32)
        .sum();
    
    let average_word_length = if word_count > 0 {
        total_word_length as f64 / word_count as f64
    } else {
        0.0
    };

    let stats = TextStats {
        word_count,
        character_count,
        character_count_no_spaces,
        sentence_count,
        average_word_length,
    };

    serde_json::to_string(&stats).unwrap_or_else(|_| String::from("{}"))
}

/// Normalize text for a specific language
#[wasm_bindgen]
pub fn normalize_text(text: &str, language: &str) -> String {
    let mut normalized = text.to_string();
    
    match language {
        "de" => {
            // German: lowercase but preserve ß
            normalized = normalized.to_lowercase();
        }
        "fr" | "es" | "it" | "pt" => {
            // Romance languages: lowercase
            normalized = normalized.to_lowercase();
        }
        "hi" => {
            // Hindi: trim whitespace
            normalized = normalized.trim().to_string();
        }
        "th" => {
            // Thai: trim whitespace
            normalized = normalized.trim().to_string();
        }
        _ => {
            // English: lowercase
            normalized = normalized.to_lowercase();
        }
    }
    
    normalized
}

