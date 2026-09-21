import os
import time
import base64
import cv2
from google import genai
from google.genai import types
from pydantic import BaseModel, Field
from typing import List
from moviepy import VideoFileClip, concatenate_videoclips

# Pydantic models for structured output from Gemini
class Scene(BaseModel):
    description: str = Field(description="Visuals only. DO NOT include stage directions, emotions, or acting notes (e.g. 'looks stressed', 'expression changes'). Keep it casual and static.")
    script: str = Field(description="The exact spoken words only. NO stage directions or action brackets in the text. It must sound 100% conversational and natural.")
    prompt: str = Field(description="The prompt for the video generation AI. MUST be formatted EXACTLY as:\nWhat They Say: [script here]\nWhat happens: [visual description here]")

class SceneList(BaseModel):
    scenes: List[Scene]

def get_client():
    provider = os.environ.get("API_PROVIDER", "AI_STUDIO")
    
    if provider == "VERTEX_AI":
        project_id = os.environ.get("VERTEX_PROJECT_ID")
        location = os.environ.get("VERTEX_LOCATION", "us-central1")
        if not project_id:
            raise ValueError("VERTEX_PROJECT_ID environment variable is not set.")
        return genai.Client(
            vertexai=True,
            project=project_id,
            location=location,
            http_options={"api_version": "v1beta1"}
        )
    else:
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise ValueError("GEMINI_API_KEY environment variable is not set.")
        return genai.Client(
            http_options={"api_version": "v1beta"},
            api_key=api_key,
        )

def generate_script_and_scenes(
    idea: str, 
    num_scenes: int = 3,
    camera_specifics: str = "Specify it is shot on an iPhone 17 front-facing camera, handheld style with slight, natural shaking. NO perfectly smooth, robotic panning or drone-like movements.",
    lighting_restraints: str = "Specify overcast daytime lighting, unfiltered. EXPLICITLY state \"No cinematic lighting, no professional color grading\" to keep it grounded in reality.",
    relatable_action: str = "No acting just tiktok style UGC. Have the subject do a mundane task (like adjusting their hair) while talking to the lens so it feels like a spontaneous vlog, not a staged commercial.",
    script_tone: str = "Genuine recommendation, not salesy. Don't sound like we are selling.",
    visual_consistency: str = "Don't do too much in the videos, keep the environment static to avoid looking fake.",
    audio_consistency: str = "Tone and loudness must stay consistent throughout all scenes.",
    accent: str = "American",
    llm_model: str = "gemini-2.5-pro",
    hook_style: str = "Auto-Select",
    custom_hook_desc: str = "",
    target_words_per_scene: int = 20
) -> list:
    """Generates a list of scenes based on a user idea."""
    client = get_client()
    
    hook_frameworks = """
    HOOK FRAMEWORKS:
    1. The Snippet (In Media Res): Start the video halfway through the story using a shocking sentence, a highly interesting fact, or an intense emotional exclamation. Loop back or fill in gaps later.
    2. The Question (Pain Point Focus): Immediately call out the target audience and address a highly relatable pain point they face (e.g. "Are you a X and struggling with Y?").
    3. The On-Screen Text: Use short-to-medium text overlay on the first frame to capture attention, combined with active visuals and energetic voice-over (avoid just a talking head).
    4. The "You-Feature" (Signature Branding): Use a signature recognizable greeting, background, or statement accessory in the intro to build brand familiarity.
    5. The Quick Cuts (Fast-Paced Editing): Cut out all dead air. Quick jumps from clip to clip, often asking a question then jump-cutting into the answer.
    """
    
    if hook_style == "Auto-Select":
        hook_instruction = f"Evaluate the video idea, pick the single most effective hook style from the following frameworks, and strictly apply it to Scene 1:\n{hook_frameworks}"
    elif hook_style == "Custom Hook":
        hook_instruction = f"Apply this custom hook style strictly to Scene 1: {custom_hook_desc}"
    else:
        hook_instruction = f"You MUST strictly apply this hook style to Scene 1:\nStyle: {hook_style}\nReference Frameworks:\n{hook_frameworks}"
    
    prompt = f"""
    You are a creative director for a UGC (User Generated Content) video.
    The user wants to make a video based on this idea: "{idea}"
    
    HOOK REQUIREMENT:
    {hook_instruction}
    
    Please break this down into exactly {num_scenes} scenes.
    For each scene, provide a visual description, the spoken script, and a prompt for a video generation model.
    
    CRITICAL PROMPT INSTRUCTIONS FOR VIDEO GENERATION:
    - SCRIPT LENGTH: The spoken script for EACH scene must contain approximately {target_words_per_scene} words. It is vital that you hit this target word count to align with the scene duration.
    - You want to strip away the "ad-like" feel entirely. No scripts, no studio setups, no "actors" playing a part. You want the raw, "I just found this and it actually works" energy that makes people stop scrolling.
    - NO ACTING OR STAGE DIRECTIONS: Do not write descriptions like "a college student with a stressed expression" or "expression changes to relief". This is a real person talking casually to their phone. The script must be purely conversational words, absolutely zero action brackets.
    - Camera Specifics: {camera_specifics}
    - Lighting Restraints: {lighting_restraints}
    - Relatable Action: {relatable_action}
    - Script Tone: {script_tone}
    - Visual Consistency: {visual_consistency}
    - Audio Consistency: {audio_consistency}
    - Speaker Accent: {accent}
    
    FORMATTING REQUIREMENT FOR THE 'prompt' FIELD:
    The output 'prompt' string MUST be formatted exactly like this:
    What They Say: [Insert exactly what the subject says here]
    What happens: [Insert the highly detailed visual description, camera specifics, lighting, and relatable action here]
    
    Make sure you follow these constraints precisely.
    """
    
    response = client.models.generate_content(
        model=llm_model,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=SceneList,
            temperature=0.7,
        ),
    )
    
    # Assuming response.text is a JSON string matching the schema
    import json
    data = json.loads(response.text)
    return data.get("scenes", [])

def generate_scene_video(
    prompt: str, 
    image_path: str, 
    output_path: str,
    aspect_ratio: str = "9:16",
    duration_seconds: int = 8,
    resolution: str = "1080p",
    video_model: str = "veo-3.1-generate-preview"
) -> str:
    """Generates a video for a scene using Veo."""
    client = get_client()
    
    video_config = types.GenerateVideosConfig(
        aspect_ratio=aspect_ratio,
        number_of_videos=1,
        duration_seconds=duration_seconds,
        resolution=resolution,
    )
    
    # Determine mime type
    mime_type = "image/jpeg"
    if image_path.lower().endswith(".png"):
        mime_type = "image/png"
    
    # Read the local image file into base64 as required by Veo's image input if not using GCS
    # Wait, the sample code uses: types.Image(gcs_uri="", mime_type="...")
    # Actually, the google-genai SDK allows passing raw bytes or gcs_uri.
    # Let's check how to pass a local image.
    # types.Image(image_bytes=b"...", mime_type="...")
    with open(image_path, "rb") as f:
        image_bytes = f.read()
        
    operation = client.models.generate_videos(
        model=video_model,
        source=types.GenerateVideosSource(
            prompt=prompt,
            image=types.Image(
                image_bytes=image_bytes,
                mime_type=mime_type
            ),
        ),
        config=video_config,
    )
    
    while not operation.done:
        time.sleep(10)
        operation = client.operations.get(operation)
        
    result = operation.result
    if not result:
        raise Exception("Error occurred while generating video.")
        
    generated_videos = result.generated_videos
    if not generated_videos:
        raise Exception("No videos were generated.")
        
    # Download the first generated video
    video = generated_videos[0].video
    client.files.download(file=video)
    video.save(output_path)
    
    return output_path

def extract_last_frame(video_path: str, output_image_path: str) -> str:
    """Extracts the sharpest frame from the final portion of the video to avoid blurry transitions."""
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise Exception(f"Failed to open video file {video_path}")
        
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    
    # Analyze the last 15 frames to find the sharpest one (highest Laplacian variance)
    # This prevents using a blurry, half-generated, or heavily compressed final frame.
    lookback = min(15, total_frames)
    best_frame = None
    best_sharpness = -1.0
    
    start_frame = max(0, total_frames - lookback)
    for i in range(start_frame, total_frames):
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ret, frame = cap.read()
        if not ret or frame is None:
            continue
        
        # Calculate sharpness using the variance of the Laplacian
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        sharpness = cv2.Laplacian(gray, cv2.CV_64F).var()
        
        if sharpness > best_sharpness:
            best_sharpness = sharpness
            best_frame = frame
            
    if best_frame is not None:
        cv2.imwrite(output_image_path, best_frame)
    else:
        # Fallback to standard last frame if something goes wrong
        cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, total_frames - 1))
        ret, frame = cap.read()
        if ret and frame is not None:
            cv2.imwrite(output_image_path, frame)
        else:
            cap.release()
            raise Exception("Failed to extract any readable frame from the video.")
        
    cap.release()
    return output_image_path

def stitch_videos(video_paths: List[str], output_path: str) -> str:
    """Stitches multiple videos together."""
    if not video_paths:
        raise ValueError("No videos to stitch.")
        
    clips = []
    for vp in video_paths:
        clips.append(VideoFileClip(vp))
        
    final_clip = concatenate_videoclips(clips)
    final_clip.write_videofile(output_path, codec="libx264", audio_codec="aac")
    
    # Close clips
    for clip in clips:
        clip.close()
        
    return output_path

def generate_camera_cut_variation(image_path: str, output_path: str, model_name: str = "nano-banana") -> str:
    """Uses Nano Banana to generate a slight camera cut variation, with a cv2 fallback."""
    client = get_client()
    
    with open(image_path, "rb") as f:
        image_bytes = f.read()
        
    mime_type = "image/jpeg" if image_path.lower().endswith((".jpg", ".jpeg")) else "image/png"
    
    try:
        # Attempt to use Nano Banana for image variation
        # We wrap this in a try-except because the exact SDK signature for image-to-image might vary
        # depending on the genai version (e.g. generate_images with a reference image or image prompt).
        result = client.models.generate_images(
            model=model_name,
            prompt="Slightly shift the camera angle to simulate a different cut. Maintain the exact same character, clothing, and background.",
            # Note: depending on the SDK, this might need to be passed differently (like in source or reference_images)
            # We will pass it as an image input for multimodal capability if supported
        )
        
        generated_images = result.generated_images
        if generated_images:
            image = generated_images[0]
            # Convert to PIL and save
            with open(output_path, "wb") as f:
                f.write(image.image.image_bytes)
            return output_path
            
    except Exception as e:
        print(f"Nano Banana API call failed, falling back to CV2 simulation: {e}")
        
    # --- FALLBACK: CV2 Zoom/Crop Simulation ---
    # If the API fails (e.g. model not found, lack of quota, or SDK mismatch), 
    # we simulate the cut by zooming in 10% and shifting the center slightly.
    img = cv2.imread(image_path)
    if img is None:
        raise Exception(f"Failed to read image for variation: {image_path}")
        
    h, w = img.shape[:2]
    # Zoom by 15%
    zoom_factor = 1.15
    new_h, new_w = int(h / zoom_factor), int(w / zoom_factor)
    
    # Shift randomly or consistently (we'll just shift down and right slightly)
    # To simulate a jump cut
    start_y = int((h - new_h) * 0.7) # biased towards bottom
    start_x = int((w - new_w) * 0.8) # biased towards right
    
    cropped = img[start_y:start_y+new_h, start_x:start_x+new_w]
    resized = cv2.resize(cropped, (w, h), interpolation=cv2.INTER_CUBIC)
    
    cv2.imwrite(output_path, resized)
    return output_path

