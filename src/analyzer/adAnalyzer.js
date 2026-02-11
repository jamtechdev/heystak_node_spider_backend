import OpenAI from "openai";
import axios from "axios";
import { createReadStream } from "fs";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { tmpdir } from "os";
import { join } from "path";
import { unlink } from "fs/promises";
import {
  TEXT_ANALYSIS_PROMPT,
  IMAGE_ANALYSIS_PROMPT,
  VIDEO_FRAME_PROMPT,
} from "./prompts.js";
import { workerLogger } from "../core/logger.js";
import { validateHook } from "./hookValidator.js"; // 🔧 HOOK VALIDATOR — added import

export class AdAnalyzer {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.client = new OpenAI({ apiKey });
    this.totalTokens = 0;
    this.totalCost = 0.0;
  }

  _parseJsonResponse(content) {
    try {
      // Remove markdown code blocks if present
      let cleaned = content.trim();
      if (cleaned.startsWith("```json")) {
        cleaned = cleaned.replace(/^```json\s*/, "").replace(/\s*```$/, "");
      } else if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "");
      }
      return JSON.parse(cleaned);
    } catch (error) {
      workerLogger.error(`[Analyzer] Failed to parse JSON: ${error.message}`);
      workerLogger.debug(
        `[Analyzer] Raw content: ${content.substring(0, 500)}`,
      );
      return null;
    }
  }

  async analyzeAd(ad, mode = "balanced") {
    if (!this.apiKey) {
      workerLogger.warn("[Analyzer] No OpenAI API key provided");
      return ad;
    }

    try {
      // Apify returns data in snapshot format, so check both formats
      const snapshot = ad.snapshot || {};
      const body = snapshot.body || {};
      const adCopy =
        typeof body === "object" && body.text
          ? body.text
          : (body ? String(body) : "") ||
            ad.ad_creative_bodies?.[0]?.text ||
            ad.ad_creative_bodies?.[0] ||
            "";
      const brandName = ad.page_name || "Unknown";
      const ctaText =
        snapshot.cta_text || ad.ad_creative_link_titles?.[0] || "";
      const ctaType =
        snapshot.cta_type || ad.ad_creative_link_descriptions?.[0] || "";

      // Check if ad has videos (for hooks/persona generation) and images (for headline generation)
      const videos = snapshot.videos || [];
      const hasVideo = videos.length > 0;
      const hasImages = (snapshot.images || []).length > 0;

      workerLogger.debug(
        `[Analyzer] Ad media type - Has video: ${hasVideo}, Has images: ${hasImages}`,
      );

      let analysis = null;

      // Video ads: Generate hooks, persona, headline from transcript
      if (hasVideo) {
        workerLogger.info(
          `[Analyzer] Video ad detected, starting transcription and analysis...`,
        );
        analysis = await this._analyzeVideo(ad, brandName, ctaText, ctaType);

        if (!analysis) {
          workerLogger.warn(`[Analyzer] Video analysis failed completely`);
        } else if (analysis.analysis_mode === "video_no_transcript") {
          workerLogger.info(
            `[Analyzer] Video had no meaningful transcript - NO HOOK generated`,
          );

          // Try to get persona/headline from image if available
          if (hasImages) {
            workerLogger.info(
              `[Analyzer] Attempting to get persona/headline from image...`,
            );
            const imageAnalysis = await this._analyzeImage(
              ad,
              brandName,
              ctaText,
            );

            if (imageAnalysis) {
              // Add persona from image (if available)
              if (imageAnalysis.persona) {
                analysis.persona = imageAnalysis.persona;
              }
              // Add headline from image (if available)
              if (
                imageAnalysis.headline ||
                imageAnalysis.extracted_text?.headline
              ) {
                analysis.headline = {
                  primary:
                    imageAnalysis.headline?.primary ||
                    imageAnalysis.extracted_text?.headline,
                  secondary: imageAnalysis.headline?.secondary,
                };
              }
              analysis.media_types_analyzed = ["video", "image"];
            }
          }
        } else {
          workerLogger.info(
            `[Analyzer] Video analysis complete with transcript`,
          );
        }
      }
      // Image-only ads: Generate headline only (no hooks, no persona)
      else if (hasImages) {
        workerLogger.info(
          `[Analyzer] Image-only ad detected, generating headline only...`,
        );
        const imageAnalysis = await this._analyzeImage(ad, brandName, ctaText);

        if (imageAnalysis) {
          // Only keep headline from image analysis, remove hooks and persona
          analysis = {
            headline:
              imageAnalysis.headline || imageAnalysis.extracted_text?.headline
                ? {
                    primary:
                      imageAnalysis.headline?.primary ||
                      imageAnalysis.extracted_text?.headline,
                    secondary: imageAnalysis.headline?.secondary,
                  }
                : null,
            analysis_mode: "image",
            media_types_analyzed: ["image"],
            analyzed_at: new Date().toISOString(),
            // No hook, no persona for image ads
          };

          // Remove headline if it's empty
          if (
            !analysis.headline ||
            (!analysis.headline.primary && !analysis.headline.secondary)
          ) {
            analysis.headline = null;
          }
        }
      }
      // No media found
      else {
        workerLogger.warn(
          `[Analyzer] No video or image found in ad, skipping analysis`,
        );
        return ad;
      }

      if (analysis) {
        ad.analysis = analysis;
        workerLogger.debug(
          `[Analyzer] Analysis attached to ad. Has hook: ${!!analysis.hook}, Has persona: ${!!analysis.persona}, Has headline: ${!!analysis.headline}`,
        );
      } else {
        workerLogger.warn(`[Analyzer] No analysis generated for ad`);
      }

      return ad;
    } catch (error) {
      workerLogger.error(`[Analyzer] Error analyzing ad: ${error.message}`);
      return ad;
    }
  }

  async _analyzeText(adCopy, brandName, ctaText, ctaType) {
    if (!adCopy) {
      return null;
    }

    const prompt = TEXT_ANALYSIS_PROMPT.replace("{ad_copy}", adCopy)
      .replace("{brand_name}", brandName)
      .replace("{cta_text}", ctaText)
      .replace("{cta_type}", ctaType);

    try {
      const response = await this.client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are an expert ad analyst. Return ONLY valid JSON, no markdown, no explanations.",
          },
          { role: "user", content: prompt },
        ],
        max_tokens: 2000,
        temperature: 0.3,
      });

      this.totalTokens += response.usage.total_tokens;
      const content = response.choices[0].message.content;
      return this._parseJsonResponse(content);
    } catch (error) {
      workerLogger.error(`[Analyzer] Text analysis error: ${error.message}`);
      return null;
    }
  }

  async _analyzeImage(ad, brandName, ctaText) {
    // Check multiple possible image URL locations
    const snapshot = ad.snapshot || {};
    const images = snapshot.images || [];
    const imageUrl =
      images[0]?.original_image_url ||
      images[0]?.resized_image_url ||
      ad.ad_snapshot_url ||
      ad.image_url ||
      snapshot.image_url;
    if (!imageUrl) {
      return null;
    }

    const prompt = IMAGE_ANALYSIS_PROMPT.replace(
      "{brand_name}",
      brandName,
    ).replace("{cta_text}", ctaText);

    try {
      const response = await this.client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are an expert visual ad analyst. Return ONLY valid JSON, no markdown, no explanations.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
        max_tokens: 2000,
        temperature: 0.3,
      });

      this.totalTokens += response.usage.total_tokens;
      const content = response.choices[0].message.content;
      return this._parseJsonResponse(content);
    } catch (error) {
      workerLogger.error(`[Analyzer] Image analysis error: ${error.message}`);
      return null;
    }
  }

  async _analyzeVideo(ad, brandName, ctaText, ctaType) {
    // Get video URL from snapshot
    const snapshot = ad.snapshot || {};
    const videos = snapshot.videos || [];
    const videoUrl =
      videos[0]?.video_hd_url || videos[0]?.video_sd_url || ad.video_url;

    if (!videoUrl) {
      workerLogger.warn(`[Analyzer] No video URL found`);
      return null;
    }

    try {
      // Step 1: Transcribe audio first
      workerLogger.info(`[Analyzer] Transcribing video audio...`);
      const transcript = await this._transcribeAudio(videoUrl);

      // STRICT CHECK: No transcript = No hook, no persona
      // A valid hook-worthy transcript must be REAL SPOKEN AD CONTENT
      const trimmedTranscript = transcript?.trim() || "";
      const wordCount = trimmedTranscript
        .split(/\s+/)
        .filter((w) => w.length > 0).length;
      const lowerTranscript = trimmedTranscript.toLowerCase();

      // Filter out garbage transcripts
      const garbagePhrases = [
        "thank you for watching",
        "thanks for watching",
        "subscribe",
        "like and subscribe",
        "click the link",
        "link in bio",
        "sign up now",
        "please sign up",
        "caught on camera",
        "psychic reading",
        "follow for more",
        "link in description",
      ];
      const isGarbagePhrase = garbagePhrases.some((phrase) =>
        lowerTranscript.includes(phrase),
      );

      // Detect song lyrics / repetitive text (same phrase repeated)
      const words = lowerTranscript.split(/\s+/);
      const uniqueWords = new Set(words);
      const repetitionRatio = uniqueWords.size / words.length;
      const isSongLyrics = words.length > 5 && repetitionRatio < 0.5; // More than 50% repeated words = lyrics

      // Detect gibberish (random numbers, nonsense)
      const hasExcessiveNumbers =
        (trimmedTranscript.match(/\d/g) || []).length > 5;
      const isGibberish =
        /^\d+\s/.test(trimmedTranscript) || hasExcessiveNumbers;

      // Requirements:
      // 1. At least 100 characters
      // 2. At least 15 words
      // 3. Not garbage phrases
      // 4. Not song lyrics (repetitive)
      // 5. Not gibberish
      const hasValidTranscript =
        trimmedTranscript.length >= 100 &&
        wordCount >= 15 &&
        !isGarbagePhrase &&
        !isSongLyrics &&
        !isGibberish;

      let rejectedReason = null;
      if (trimmedTranscript.length < 100 || wordCount < 15)
        rejectedReason = "too_short";
      else if (isGarbagePhrase) rejectedReason = "garbage_phrase";
      else if (isSongLyrics) rejectedReason = "song_lyrics";
      else if (isGibberish) rejectedReason = "gibberish";

      if (!hasValidTranscript) {
        workerLogger.warn(
          `[Analyzer] Transcript rejected (length: ${trimmedTranscript.length}, words: ${wordCount}, reason: ${rejectedReason}). NO HOOK.`,
        );
        // Return only hook: null, persona/headline will come from image analysis
        return {
          hook: null,
          transcript_analysis: {
            full_transcript: trimmedTranscript || null,
            has_speech: trimmedTranscript.length > 0,
            rejected_reason: rejectedReason,
          },
          analysis_mode: "video_no_transcript",
          media_types_analyzed: ["video"],
          analyzed_at: new Date().toISOString(),
        };
      }

      workerLogger.info(
        `[Analyzer] Valid transcript generated (${transcript.length} chars), analyzing for hooks/persona/headline...`,
      );

      // Step 2: Use transcript to generate hooks, persona, headline
      const prompt = VIDEO_FRAME_PROMPT.replace(
        "{brand_name}",
        brandName,
      ).replace("{transcript}", transcript);

      const response = await this.client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are an expert video ad analyst. Return ONLY valid JSON, no markdown, no explanations.",
          },
          { role: "user", content: prompt },
        ],
        max_tokens: 2000,
        temperature: 0.3,
      });

      this.totalTokens += response.usage.total_tokens;
      const content = response.choices[0].message.content;
      const analysis = this._parseJsonResponse(content);

      // ────────────────────────────────────────────────────────────
      // 🔧 HOOK VALIDATOR — enforce hook = first sentence of transcript
      // ────────────────────────────────────────────────────────────
      if (analysis && analysis.hook) {
        const gptHookText =
          analysis.hook.text || analysis.hook.audio_hook || "";
        const validated = validateHook(gptHookText, transcript);

        // Overwrite with validated hook
        analysis.hook.text = validated.hook;
        analysis.hook.audio_hook = validated.hook;

        // Debug metadata (safe to remove later)
        analysis.hook._validation = {
          source: validated.source, // 'gpt' | 'first_sentence' | 'first_n_words'
          similarity: validated.score,
          reason: validated.reason,
          original_gpt:
            gptHookText !== validated.hook ? gptHookText : undefined,
        };

        // If total failure, null out the hook
        if (!validated.hook) {
          analysis.hook = null;
          workerLogger.warn(
            `[Analyzer] Hook validation failed — hook set to null`,
          );
        }
      }
      // ────────────────────────────────────────────────────────────
      // 🔧 END HOOK VALIDATOR
      // ────────────────────────────────────────────────────────────

      // Ensure transcript is stored in analysis
      if (analysis && !analysis.transcript_analysis) {
        analysis.transcript_analysis = {
          full_transcript: transcript,
          has_speech: true,
        };
      } else if (analysis && analysis.transcript_analysis) {
        analysis.transcript_analysis.full_transcript = transcript;
        analysis.transcript_analysis.has_speech = true;
      }

      // Set analysis metadata
      if (analysis) {
        analysis.analysis_mode = "video_transcript";
        analysis.media_types_analyzed = ["video"];
        analysis.analyzed_at = new Date().toISOString();
      }

      return analysis;
    } catch (error) {
      workerLogger.error(`[Analyzer] Video analysis error: ${error.message}`);
      return null;
    }
  }

  async _transcribeAudio(videoUrl) {
    try {
      // Download video to temp file
      const tempFile = join(tmpdir(), `video_${Date.now()}.mp4`);
      const response = await axios.get(videoUrl, { responseType: "stream" });
      await pipeline(response.data, createWriteStream(tempFile));

      // Transcribe using Whisper with verbose_json to get no_speech detection
      const transcription = await this.client.audio.transcriptions.create({
        file: createReadStream(tempFile),
        model: "whisper-1",
        response_format: "verbose_json",
        temperature: 0, // More deterministic, less hallucination
      });

      // Cleanup temp file
      await unlink(tempFile);

      // Check if there's actually speech in the audio
      // verbose_json returns segments with no_speech_prob
      const segments = transcription.segments || [];

      if (segments.length === 0) {
        workerLogger.warn(
          `[Analyzer] Whisper returned no segments - no speech detected`,
        );
        return null;
      }

      // Calculate average no_speech probability
      // If most segments have high no_speech_prob, it's likely music/ambient
      const avgNoSpeechProb =
        segments.reduce((sum, seg) => sum + (seg.no_speech_prob || 0), 0) /
        segments.length;

      workerLogger.debug(
        `[Analyzer] Whisper segments: ${segments.length}, avg no_speech_prob: ${avgNoSpeechProb.toFixed(3)}`,
      );

      // If average no_speech probability > 0.5, likely no real speech
      if (avgNoSpeechProb > 0.5) {
        workerLogger.warn(
          `[Analyzer] High no_speech probability (${avgNoSpeechProb.toFixed(3)}) - likely music/ambient, not speech`,
        );
        return null;
      }

      // Filter out segments with high no_speech probability
      const speechSegments = segments.filter(
        (seg) => (seg.no_speech_prob || 0) < 0.7,
      );

      if (speechSegments.length === 0) {
        workerLogger.warn(
          `[Analyzer] All segments have high no_speech_prob - no valid speech`,
        );
        return null;
      }

      // Combine text from valid speech segments only
      const text = speechSegments
        .map((seg) => seg.text)
        .join(" ")
        .trim();

      workerLogger.debug(
        `[Analyzer] Filtered transcript (${speechSegments.length}/${segments.length} segments): ${text.substring(0, 100)}...`,
      );

      return text;
    } catch (error) {
      workerLogger.error(`[Analyzer] Transcription error: ${error.message}`);
      return null;
    }
  }

  _combineAnalyses(textAnalysis, imageAnalysis) {
    if (!textAnalysis && !imageAnalysis) {
      return null;
    }
    if (!textAnalysis) {
      return imageAnalysis;
    }
    if (!imageAnalysis) {
      return textAnalysis;
    }

    // Merge analyses intelligently - prefer text for hook/headline, merge persona, add visual
    const combined = {
      ...textAnalysis,
      // Merge hook - prefer text hook but add visual hook if present
      hook: {
        ...textAnalysis.hook,
        ...(imageAnalysis.hook?.visual_hook && {
          visual_hook: imageAnalysis.hook.visual_hook,
        }),
        // Use higher score if available
        score: Math.max(
          textAnalysis.hook?.score || 0,
          imageAnalysis.hook?.score || 0,
        ),
      },
      // Merge headline - prefer text but add image extracted text
      headline: {
        ...textAnalysis.headline,
        ...(imageAnalysis.extracted_text?.headline && {
          image_headline: imageAnalysis.extracted_text.headline,
        }),
      },
      // Merge persona - combine arrays, prefer text for summary
      persona: {
        ...textAnalysis.persona,
        ...(imageAnalysis.persona && {
          interests: [
            ...(textAnalysis.persona?.interests || []),
            ...(imageAnalysis.persona?.interests || []),
          ].filter((v, i, a) => a.indexOf(v) === i), // Remove duplicates
          pain_points: [
            ...(textAnalysis.persona?.pain_points || []),
            ...(imageAnalysis.persona?.pain_points || []),
          ].filter((v, i, a) => a.indexOf(v) === i),
          desires: [
            ...(textAnalysis.persona?.desires || []),
            ...(imageAnalysis.persona?.desires || []),
          ].filter((v, i, a) => a.indexOf(v) === i),
        }),
      },
      // Add visual analysis
      visual_analysis: imageAnalysis.visual_analysis,
      extracted_text: imageAnalysis.extracted_text,
      combined: true,
    };

    return combined;
  }

  _combineAllAnalyses(textAnalysis, imageAnalysis, videoAnalysis) {
    const combined = this._combineAnalyses(textAnalysis, imageAnalysis);
    if (videoAnalysis) {
      return {
        ...combined,
        video: videoAnalysis.video_analysis,
        transcript: videoAnalysis.transcript_analysis,
      };
    }
    return combined;
  }

  close() {
    // OpenAI client doesn't need explicit cleanup
  }
}

export default AdAnalyzer;
