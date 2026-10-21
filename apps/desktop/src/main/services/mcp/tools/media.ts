import {
  imageGenerationReady,
  speechGenerationReady,
  videoGenerationReady,
  videoPromptingGuide,
} from "../../agent-tools/media-generation";
import type { ToolDefinition } from "./definition";

/**
 * Understanding and generating images, audio and video. A generator is listed
 * only with a provider to run on; without one, `paid_feature` says where to get it.
 */
export const MEDIA_TOOLS: ToolDefinition[] = [
  {
    name: "vision_analyze",
    toolsets: ["vision"],
    description:
      "Look at an image and answer a question about it. Accepts a local file path or an http(s) URL.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Image path or URL." },
        prompt: {
          type: "string",
          description:
            "What you want to know. Defaults to a general description.",
        },
      },
      required: ["source"],
    },
    run: (host, args) => host.analyze(args, "image"),
  },
  {
    name: "video_analyze",
    toolsets: ["video"],
    description:
      "Watch a video and answer a question about it. Needs a video-capable model; not every vision provider accepts video.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Video path or URL." },
        prompt: { type: "string", description: "What you want to know." },
      },
      required: ["source"],
    },
    run: (host, args) => host.analyze(args, "video"),
  },
  {
    name: "image_generate",
    toolsets: ["image_gen"],
    ready: imageGenerationReady,
    description: [
      "Generate an image, or edit one: pass the picture to change (an attachment, a file, an earlier result) in images, and say in prompt what to change.",
      "This is the tool for making or changing a picture. Use a connected app (a design or model-hosting service) only when the user asks for that service by name, and never re-create a picture from a description when you can pass it.",
      "Returns the path to the saved file and markdown that shows it in the chat: show it that way. Never link to an image on a third-party site instead.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        images: {
          type: "array",
          items: { type: "string" },
          maxItems: 4,
          description:
            "Pictures to edit or follow, as file paths or https URLs. The first is the one to change.",
        },
        text: {
          type: "string",
          description:
            "Every word the image must show, exactly as the user wants it, one line per line of the design, top to bottom. The image is checked against it and regenerated once if it reads differently. When the user's words leave the text or its order open to more than one reading, ask which they mean first.",
        },
        size: {
          type: "string",
          description: 'Provider-specific, e.g. "1024x1024".',
        },
      },
      required: ["prompt"],
    },
    run: (host, args) => host.imageGenerate(args),
  },
  {
    name: "text_to_speech",
    toolsets: ["tts"],
    ready: speechGenerationReady,
    description:
      "Turn text into spoken audio. Returns the path to the saved file.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        voice: {
          type: "string",
          description: "Provider-specific voice name or id.",
        },
      },
      required: ["text"],
    },
    run: (host, args) => host.textToSpeech(args),
  },
  {
    name: "video_generate",
    toolsets: ["video_gen"],
    ready: videoGenerationReady,
    description:
      "Start generating a video from a prompt, optionally driven by a still image. Returns a job id. Generation takes minutes, so poll with bfl_flux3_get_result.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        image_url: {
          type: "string",
          description: "Optional still to animate.",
        },
      },
      required: ["prompt"],
    },
    run: (host, args) => host.submitVideoJob(args),
  },
  {
    name: "xai_video_edit",
    toolsets: ["video_gen"],
    ready: videoGenerationReady,
    description:
      "Re-generate an existing video against a new prompt. Returns a job id to poll.",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string" }, video_url: { type: "string" } },
      required: ["prompt", "video_url"],
    },
    run: (host, args) => host.submitVideoJob(args),
  },
  {
    name: "xai_video_extend",
    toolsets: ["video_gen"],
    ready: videoGenerationReady,
    description:
      "Continue an existing video past its end. Returns a job id to poll.",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string" }, video_url: { type: "string" } },
      required: ["prompt", "video_url"],
    },
    run: (host, args) => host.submitVideoJob(args),
  },
  {
    name: "bfl_flux3_text_to_video",
    toolsets: ["bfl"],
    ready: videoGenerationReady,
    description:
      "Start a video generation from a prompt alone. Returns a job id to poll.",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
    },
    run: (host, args) => host.submitVideoJob(args),
  },
  {
    name: "bfl_flux3_image_to_video",
    toolsets: ["bfl"],
    ready: videoGenerationReady,
    description:
      "Start a video generation from a still image. Returns a job id to poll.",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string" }, image_url: { type: "string" } },
      required: ["prompt", "image_url"],
    },
    run: (host, args) => host.submitVideoJob(args),
  },
  {
    name: "bfl_flux3_keyframes_to_video",
    toolsets: ["bfl"],
    ready: videoGenerationReady,
    description:
      "Start a video generation that passes through given keyframes. Returns a job id to poll.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        keyframes: {
          type: "array",
          items: { type: "string" },
          description: "Image URLs, in order.",
        },
      },
      required: ["prompt", "keyframes"],
    },
    run: (host, args) => host.submitVideoJob(args),
  },
  {
    name: "bfl_flux3_video_continuation",
    toolsets: ["bfl"],
    ready: videoGenerationReady,
    description: "Continue an existing video. Returns a job id to poll.",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string" }, video_url: { type: "string" } },
      required: ["prompt", "video_url"],
    },
    run: (host, args) => host.submitVideoJob(args),
  },
  {
    name: "bfl_flux3_get_result",
    toolsets: ["bfl", "video_gen"],
    ready: videoGenerationReady,
    description:
      "Check a video job. Returns the file path once it is done, or how long it has been running. Poll every 20-30 seconds rather than in a tight loop.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
    run: (host, args) => host.pollVideoJob(args),
  },
  {
    name: "bfl_flux3_prompting_guide",
    toolsets: ["bfl", "video_gen"],
    ready: videoGenerationReady,
    description:
      "Read guidance on writing video prompts before generating. Costs nothing and improves results.",
    inputSchema: { type: "object", properties: {} },
    run: (host) => host.ok(videoPromptingGuide()),
  },
];
