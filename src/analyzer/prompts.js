export const TEXT_ANALYSIS_PROMPT = `Analyze this Facebook/Instagram ad and extract detailed information.

AD COPY:
{ad_copy}

BRAND: {brand_name}
CTA: {cta_text}
CTA TYPE: {cta_type}

---

Return ONLY valid JSON (no markdown, no explanation):

{
  "hook": {
    "text": "exact first attention-grabbing line",
    "type": "question|pain_point|benefit|statistic|story|curiosity|urgency|social_proof",
    "score": 1-10
  },
  "ad_copy_analysis": {
    "full_text": "complete ad copy",
    "summary": "1 line summary",
    "word_count": number,
    "emotion": "fear|joy|curiosity|urgency|trust|excitement",
    "tone": "casual|professional|humorous|emotional|aggressive"
  },
  "headline": {
    "primary": "main headline if exists",
    "secondary": "sub-headline if exists"
  },
  "persona": {
    "age_range": "18-24|25-34|35-44|45-54|55+",
    "gender": "male|female|all",
    "interests": ["interest1", "interest2"],
    "pain_points": ["pain1", "pain2"],
    "desires": ["desire1", "desire2"],
    "income_level": "low|middle|high|premium",
    "lifestyle": "description",
    "summary": "1 line persona description"
  },
  "scores": {
    "hook_strength": 1-10,
    "clarity": 1-10,
    "urgency": 1-10,
    "emotional_appeal": 1-10,
    "overall": 1-10
  }
}`;

export const IMAGE_ANALYSIS_PROMPT = `Analyze this Facebook/Instagram ad image and extract detailed information.

BRAND: {brand_name}
CTA: {cta_text}

Look at the image and identify:
1. Any text/copy visible in the image
2. Visual hook (what grabs attention)
3. Target persona based on imagery
4. Overall message

---

Return ONLY valid JSON (no markdown, no explanation):

{
  "hook": {
    "text": "text hook if visible in image, otherwise describe visual hook",
    "visual_hook": "what visually grabs attention (colors, faces, product, etc)",
    "type": "question|pain_point|benefit|statistic|story|curiosity|urgency|social_proof|visual",
    "score": 1-10
  },
  "headline": {
    "primary": "main headline/text visible in image (main message or call-to-action)",
    "secondary": "sub-headline or supporting text if visible"
  },
  "extracted_text": {
    "headline": "main text/headline visible",
    "body_text": "any other text visible",
    "cta_text": "button/cta text if visible"
  },
  "visual_analysis": {
    "main_subject": "what is the main focus",
    "colors": ["primary colors used"],
    "style": "minimal|bold|colorful|dark|professional|casual",
    "has_person": true/false,
    "has_product": true/false,
    "emotion_conveyed": "emotion the image conveys"
  },
  "persona": {
    "age_range": "18-24|25-34|35-44|45-54|55+",
    "gender": "male|female|all",
    "interests": ["interest1", "interest2"],
    "pain_points": ["pain1", "pain2"],
    "desires": ["desire1", "desire2"],
    "income_level": "low|middle|high|premium",
    "lifestyle": "description",
    "summary": "1 line persona description"
  },
  "scores": {
    "visual_appeal": 1-10,
    "clarity": 1-10,
    "brand_fit": 1-10,
    "overall": 1-10
  }
}`;

export const VIDEO_FRAME_PROMPT = `Analyze these frames from a Facebook/Instagram video ad.

BRAND: {brand_name}
AUDIO TRANSCRIPT: {transcript}

Look at the video frames and identify:
1. Visual hook in first few frames
2. Key scenes/messages
3. Target persona
4. Main headline (primary message or call-to-action from transcript/video)

---

Return ONLY valid JSON (no markdown, no explanation):

{
  "hook": {
    "audio_hook": "first attention-grabbing line from transcript",
    "visual_hook": "what visually grabs attention in opening frames",
    "text": "combined hook text (audio or visual)",
    "type": "question|pain_point|benefit|statistic|story|curiosity|urgency|social_proof|visual",
    "score": 1-10
  },
  "headline": {
    "primary": "main headline/message from transcript or video (main call-to-action or key message)",
    "secondary": "sub-headline or supporting message if exists"
  },
  "video_analysis": {
    "opening_scene": "describe first 3 seconds",
    "key_scenes": ["scene1", "scene2"],
    "style": "testimonial|product_demo|lifestyle|animation|ugc|professional",
    "has_person": true/false,
    "has_product": true/false,
    "music_mood": "upbeat|calm|intense|emotional|none"
  },
  "transcript_analysis": {
    "full_transcript": "from whisper",
    "summary": "1 line summary",
    "key_messages": ["message1", "message2"]
  },
  "persona": {
    "age_range": "18-24|25-34|35-44|45-54|55+",
    "gender": "male|female|all",
    "interests": ["interest1", "interest2"],
    "pain_points": ["pain1", "pain2"],
    "desires": ["desire1", "desire2"],
    "income_level": "low|middle|high|premium",
    "lifestyle": "description",
    "summary": "1 line persona description"
  },
  "scores": {
    "hook_strength": 1-10,
    "visual_appeal": 1-10,
    "message_clarity": 1-10,
    "overall": 1-10
  }
}`;

export const COMBINE_ANALYSIS_PROMPT = `Combine these analyses into a final comprehensive analysis.

TEXT ANALYSIS:
{text_analysis}

VISUAL ANALYSIS:
{visual_analysis}

---

Return ONLY valid JSON with the best/combined insights:

{
  "hook": {
    "primary_hook": "the strongest hook (text or visual)",
    "text_hook": "text hook if exists",
    "visual_hook": "visual hook",
    "type": "hook type",
    "score": 1-10
  },
  "ad_copy": {
    "text": "full ad copy",
    "summary": "1 line summary"
  },
  "headline": {
    "primary": "main headline",
    "secondary": "sub-headline"
  },
  "persona": {
    "age_range": "range",
    "gender": "target gender",
    "interests": ["interests"],
    "pain_points": ["pains"],
    "desires": ["desires"],
    "summary": "1 line description"
  },
  "overall_score": 1-10
}`;
