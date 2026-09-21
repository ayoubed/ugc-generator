import streamlit as st
import os
import shutil
import tempfile
from dotenv import load_dotenv
from streamlit_local_storage import LocalStorage
from streamlit_tags import st_tags
# Load env variables if any
load_dotenv()

import importlib
import video_pipeline
importlib.reload(video_pipeline)

from video_pipeline import (
    generate_script_and_scenes,
    generate_scene_video,
    extract_last_frame,
    stitch_videos,
    generate_camera_cut_variation
)

st.set_page_config(page_title="UGC Video Generator", layout="wide")

# Ensure temp directory exists for generations
if "temp_dir" not in st.session_state:
    st.session_state.temp_dir = tempfile.mkdtemp()

def sync_prompt(i):
    if f"desc_{i}" in st.session_state and f"script_{i}" in st.session_state:
        desc = st.session_state[f"desc_{i}"]
        script = st.session_state[f"script_{i}"]
        st.session_state[f"prompt_{i}"] = f"What They Say: {script}\nWhat happens: {desc}"

def delete_scene(i):
    if len(st.session_state.scenes) > i:
        st.session_state.scenes.pop(i)
        # Clear widget states to force Streamlit to rebuild them correctly
        keys_to_clear = [k for k in st.session_state.keys() if k.startswith(("desc_", "script_", "prompt_"))]
        for k in keys_to_clear:
            del st.session_state[k]

@st.cache_data(ttl=3600)
def get_video_models(provider, api_key, project_id, location):
    try:
        from google import genai
        if provider == "VERTEX_AI":
            if not project_id:
                return ["veo-3.1-generate-preview"]
            client = genai.Client(vertexai=True, project=project_id, location=location, http_options={"api_version": "v1beta"})
        else:
            if not api_key:
                return ["veo-3.1-generate-preview"]
            client = genai.Client(http_options={"api_version": "v1beta"}, api_key=api_key)
        v_models = []
        for m in client.models.list_models():
            if "veo" in m.name.lower():
                name = m.name.split("/")[-1] if "/" in m.name else m.name
                v_models.append(name)
        return v_models if v_models else ["veo-3.1-generate-preview"]
    except Exception:
        return ["veo-3.1-generate-preview"]

if "step" not in st.session_state:
    st.session_state.step = 1

if "scenes" not in st.session_state:
    st.session_state.scenes = []

if "generated_videos" not in st.session_state:
    st.session_state.generated_videos = []

if "starting_images" not in st.session_state:
    st.session_state.starting_images = []

if "current_scene_index" not in st.session_state:
    st.session_state.current_scene_index = 0

if "final_video_path" not in st.session_state:
    st.session_state.final_video_path = None

def next_step():
    st.session_state.step += 1

def reset():
    st.session_state.step = 1
    st.session_state.scenes = []
    st.session_state.generated_videos = []
    st.session_state.starting_images = []
    st.session_state.current_scene_index = 0
    st.session_state.final_video_path = None

st.title("🎬 UGC Video Pipeline")

# Sidebar for API Configuration
with st.sidebar:
    st.header("API Configuration")
    api_provider = st.radio("API Provider", ["AI Studio (API Key)", "Vertex AI (GCP)"])
    
    localS = LocalStorage()
    
    if api_provider == "AI Studio (API Key)":
        os.environ["API_PROVIDER"] = "AI_STUDIO"
        
        # Try to load from Local Storage first if not in environ
        api_key_ls = localS.getItem("GEMINI_API_KEY")
        current_key = os.environ.get("GEMINI_API_KEY", "")
        
        # If we have a key from local storage but it's not in the environment, use it
        if api_key_ls and not current_key:
            current_key = api_key_ls
            os.environ["GEMINI_API_KEY"] = current_key

        api_key = st.text_input("Gemini API Key", type="password", value=current_key)
        
        if api_key:
            os.environ["GEMINI_API_KEY"] = api_key
            # Save to local storage if it's new
            if api_key != api_key_ls:
                localS.setItem("GEMINI_API_KEY", api_key)
        else:
            st.warning("Please enter your Gemini API Key")
            
    else:
        os.environ["API_PROVIDER"] = "VERTEX_AI"
        
        project_ls = localS.getItem("VERTEX_PROJECT_ID")
        current_project = os.environ.get("VERTEX_PROJECT_ID", "")
        if project_ls and not current_project:
            current_project = project_ls
            os.environ["VERTEX_PROJECT_ID"] = current_project
            
        location_ls = localS.getItem("VERTEX_LOCATION")
        current_location = os.environ.get("VERTEX_LOCATION", "us-central1")
        if location_ls and current_location == "us-central1":
            current_location = location_ls
            os.environ["VERTEX_LOCATION"] = current_location
            
        project_id = st.text_input("GCP Project ID", value=current_project)
        location = st.text_input("GCP Region", value=current_location)
        
        if project_id:
            os.environ["VERTEX_PROJECT_ID"] = project_id
            if project_id != project_ls:
                localS.setItem("VERTEX_PROJECT_ID", project_id)
        else:
            st.warning("Please enter your GCP Project ID")
            
        if location:
            os.environ["VERTEX_LOCATION"] = location
            if location != location_ls:
                localS.setItem("VERTEX_LOCATION", location)
                
        # Service Account Upload
        sa_file = st.file_uploader("Service Account JSON (Optional if ADC configured locally)", type=["json"])
        if sa_file:
            sa_path = os.path.join(st.session_state.temp_dir, "service_account.json")
            with open(sa_path, "wb") as f:
                f.write(sa_file.getbuffer())
            os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = sa_path
            st.success("Service account loaded!")
            
        with st.expander("Need help with Vertex AI setup?"):
            st.markdown("""
            **How to configure Vertex AI:**
            1. **Enable the API:** Go to Google Cloud Console, select your Project, and enable the **Vertex AI API**.
            2. **Create a Service Account:** Go to IAM & Admin > Service Accounts. Create one and grant it the **Vertex AI User** role.
            3. **Generate Key:** Create a new JSON key for that service account and upload it here.
            
            **Troubleshooting 404 Errors:**
            If you get a `404 Not Found` error, it means the selected model is not available in your region or the API isn't enabled. 
            - *Tip:* `gemini-2.5-pro` might not be available in `us-central1` yet. Try changing the Script Generation Model to `gemini-1.5-pro` if you see this error!
            """)
        
    st.header("Video Parameters")
    aspect_ratio = st.selectbox("Aspect Ratio", ["16:9", "9:16", "16:10"], index=1)
    duration = st.slider("Duration (seconds)", 5, 8, 8)
    resolution = st.selectbox("Resolution", ["720p", "1080p", "4k"], index=1)
    
    st.header("Models")
    llm_model = st.selectbox("Script Generation Model", ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-1.5-pro", "gemini-1.5-flash"], index=0)
    
    available_video_models = get_video_models(
        os.environ.get("API_PROVIDER", "AI_STUDIO"),
        os.environ.get("GEMINI_API_KEY"),
        os.environ.get("VERTEX_PROJECT_ID"),
        os.environ.get("VERTEX_LOCATION", "us-central1")
    )
    video_model = st.selectbox("Video Generation Model", available_video_models, index=0)

    st.header("Prompt Guidelines")
    camera_tags = st_tags(
        label="Camera Specifics",
        text="Press enter to add more",
        value=["iPhone 17 front-facing camera", "Handheld style", "Slight natural shaking", "NO perfectly smooth or robotic panning"],
        suggestions=["Handheld", "Tripod", "Drone", "Selfie stick", "Cinematic smooth panning"],
        maxtags=10,
        key="camera_tags"
    )
    
    lighting_tags = st_tags(
        label="Lighting Restraints",
        text="Press enter to add more",
        value=["Overcast daytime lighting", "Unfiltered", "No cinematic lighting", "No professional color grading"],
        suggestions=["Golden hour", "Neon lights", "Dark room", "Harsh sunlight"],
        maxtags=10,
        key="lighting_tags"
    )
    
    action_tags = st_tags(
        label="Relatable Action",
        text="Press enter to add more",
        value=["No acting", "Tiktok style UGC", "Doing a mundane task", "Adjusting hair while talking", "Spontaneous vlog feel", "Not a staged commercial"],
        suggestions=["Walking", "Drinking coffee", "Typing on laptop", "Looking off-camera"],
        maxtags=10,
        key="action_tags"
    )
    
    script_tags = st_tags(
        label="Script Tone",
        text="Press enter to add more",
        value=["Genuine recommendation", "Not salesy", "Don't sound like we are selling"],
        suggestions=["Excited", "Calm", "Urgent"],
        maxtags=10,
        key="script_tags"
    )
    
    visual_tags = st_tags(
        label="Visual Consistency",
        text="Press enter to add more",
        value=["Don't do too much action", "Keep environment static", "Avoid looking fake"],
        suggestions=["Dynamic background", "Fast cuts"],
        maxtags=10,
        key="visual_tags"
    )
    
    audio_tags = st_tags(
        label="Audio Consistency",
        text="Press enter to add more",
        value=["Tone and loudness must stay consistent throughout"],
        suggestions=["Volume increasing", "Whispering"],
        maxtags=10,
        key="audio_tags"
    )
    
    accent = st.selectbox("Speaker Accent", ["American", "British", "Australian", "Neutral", "Southern US", "New York"], index=0)

if os.environ.get("API_PROVIDER") == "AI_STUDIO" and not os.environ.get("GEMINI_API_KEY"):
    st.stop()
elif os.environ.get("API_PROVIDER") == "VERTEX_AI" and not os.environ.get("VERTEX_PROJECT_ID"):
    st.stop()

# Step 1: Idea and Initial Image
if st.session_state.step == 1:
    st.header("Step 1: The Idea")
    idea = st.text_area("What is your video idea?", placeholder="A guy talking about how he made money selling notes...")
    num_scenes = st.number_input("Number of scenes", min_value=1, max_value=10, value=3)
    
    # Recommended words based on the duration (e.g. 150 WPM = 2.5 words/sec)
    rec_words = int(duration * 2.5)
    words_per_scene = st.number_input("Target Script Length (words per scene)", min_value=5, max_value=100, value=rec_words)
    
    hook_style = st.selectbox("Hook Style", [
        "Auto-Select (AI chooses the best hook)",
        "The Snippet (In Media Res)",
        "The Question (Pain Point Focus)",
        "The On-Screen Text",
        "The \"You-Feature\" (Signature Branding)",
        "The Quick Cuts (Fast-Paced Editing)",
        "Custom Hook"
    ], index=0)
    
    custom_hook_desc = ""
    if hook_style == "Custom Hook":
        custom_hook_desc = st.text_area("Custom Hook Description", placeholder="Define your own custom hook style (e.g. Start by whispering a secret to the camera)")
    
    uploaded_file = st.file_uploader("Upload starting image of the person", type=["png", "jpg", "jpeg"])
    
    # Guidelines are now defined in the sidebar
        
    if st.button("Generate Scenes"):
        if not idea or not uploaded_file:
            st.error("Please provide both an idea and a starting image.")
        else:
            with st.spinner("Generating scenes using Gemini Pro..."):
                # Save the image
                ext = uploaded_file.name.split(".")[-1]
                initial_img_path = os.path.join(st.session_state.temp_dir, f"scene_0_img.{ext}")
                with open(initial_img_path, "wb") as f:
                    f.write(uploaded_file.getbuffer())
                
                # Map dropdown selection to short name for backend
                hook_map = {
                    "Auto-Select (AI chooses the best hook)": "Auto-Select",
                    "The Snippet (In Media Res)": "The Snippet (In Media Res)",
                    "The Question (Pain Point Focus)": "The Question (Pain Point Focus)",
                    "The On-Screen Text": "The On-Screen Text",
                    "The \"You-Feature\" (Signature Branding)": "The \"You-Feature\" (Signature Branding)",
                    "The Quick Cuts (Fast-Paced Editing)": "The Quick Cuts (Fast-Paced Editing)",
                    "Custom Hook": "Custom Hook"
                }
                selected_hook = hook_map[hook_style]
                
                try:
                    scenes = generate_script_and_scenes(
                        idea, 
                        num_scenes=num_scenes,
                        camera_specifics=", ".join(camera_tags),
                        lighting_restraints=", ".join(lighting_tags),
                        relatable_action=", ".join(action_tags),
                        script_tone=", ".join(script_tags),
                        visual_consistency=", ".join(visual_tags),
                        audio_consistency=", ".join(audio_tags),
                        accent=accent,
                        llm_model=llm_model,
                        hook_style=selected_hook,
                        custom_hook_desc=custom_hook_desc,
                        target_words_per_scene=words_per_scene
                    )
                    st.session_state.scenes = scenes
                    st.session_state.starting_images = [initial_img_path] # first scene gets initial image
                    next_step()
                    st.rerun()
                except Exception as e:
                    st.error(f"Error generating scenes: {e}")

# Step 2: Review and Edit Scenes
elif st.session_state.step == 2:
    st.header("Step 2: Review Scenes")
    st.write("Edit the generated prompts and scripts if necessary, then proceed to video generation.")
    
    edited_scenes = []
    for i, scene in enumerate(st.session_state.scenes):
        with st.expander(f"Scene {i+1}", expanded=True):
            desc = st.text_area(f"Description (Scene {i+1})", scene.get("description", ""), key=f"desc_{i}")
            script = st.text_area(f"Script (Scene {i+1})", scene.get("script", ""), key=f"script_{i}")
            prompt = st.text_area(f"Video Prompt (Scene {i+1})", scene.get("prompt", ""), key=f"prompt_{i}")
            edited_scenes.append({
                "description": desc,
                "script": script,
                "prompt": prompt
            })
            
    col1, col2 = st.columns(2)
    with col1:
        if st.button("Start Generating Videos"):
            st.session_state.scenes = edited_scenes
            next_step()
            st.rerun()
    with col2:
        if st.button("Back"):
            st.session_state.step = 1
            st.rerun()

# Step 3: Generation Loop
elif st.session_state.step == 3:
    st.header("Step 3: Generate Scene Videos")
    st.write("Review each scene, choose its starting image, and generate the video. You can generate them independently, but some may depend on the previous scene's completion.")
    
    # Keep track of generation status
    all_generated = True
    
    for idx, scene in enumerate(st.session_state.scenes):
        st.subheader(f"Scene {idx+1}")
        col1, col2 = st.columns([1, 1])
        
        with col1:
            st.write("**Script:**", scene.get("script", ""))
            current_prompt = st.text_area(f"Video Prompt (Scene {idx+1})", value=scene.get("prompt", ""), height=150, key=f"prompt_edit_{idx}")
            st.session_state.scenes[idx]["prompt"] = current_prompt
            
            # Image Sourcing
            if idx == 0:
                img_source = "Uploaded Image (from Step 1)"
                img_path_to_use = st.session_state.starting_images[0]
            else:
                img_source = st.radio(
                    f"Starting Image Source for Scene {idx+1}", 
                    ["Upload new image", "Use last frame of previous scene", "Use shifted frame of previous scene (AI cut)"],
                    key=f"img_source_{idx}",
                    index=1
                )
                
            new_image = None
            if idx > 0 and img_source == "Upload new image":
                new_image = st.file_uploader(f"Upload starting image for Scene {idx+1}", type=["png", "jpg", "jpeg"], key=f"img_upload_{idx}")
                
            can_generate = True
            dependency_warning = ""
            
            # Determine the actual image to use based on source selection
            if idx == 0:
                img_to_use = img_path_to_use
            else:
                if img_source == "Upload new image":
                    if new_image is not None:
                        ext = new_image.name.split(".")[-1]
                        custom_img_path = os.path.join(st.session_state.temp_dir, f"scene_{idx}_custom_img.{ext}")
                        with open(custom_img_path, "wb") as f:
                            f.write(new_image.getbuffer())
                        img_to_use = custom_img_path
                    else:
                        can_generate = False
                        dependency_warning = "Please upload an image to continue."
                        img_to_use = None
                else:
                    # Depends on previous scene
                    prev_vid = os.path.join(st.session_state.temp_dir, f"scene_{idx-1}_final.mp4")
                    if os.path.exists(prev_vid):
                        # Extract the frame if not already extracted
                        base_extracted_img = os.path.join(st.session_state.temp_dir, f"scene_{idx}_from_prev.png")
                        if not os.path.exists(base_extracted_img):
                            extract_last_frame(prev_vid, base_extracted_img)
                        
                        if img_source == "Use last frame of previous scene":
                            img_to_use = base_extracted_img
                        else:
                            # Shifted
                            shifted_img = os.path.join(st.session_state.temp_dir, f"scene_{idx}_shifted.png")
                            if not os.path.exists(shifted_img):
                                with st.spinner("Generating AI camera cut variation (Nano Banana)..."):
                                    generate_camera_cut_variation(base_extracted_img, shifted_img)
                            img_to_use = shifted_img
                    else:
                        can_generate = False
                        dependency_warning = f"Requires Scene {idx} to be generated first."
                        img_to_use = None
            
            if img_to_use and os.path.exists(img_to_use):
                st.image(img_to_use, width=300, caption="Starting Image")
            elif dependency_warning:
                st.warning(dependency_warning)
                
            final_scene_vid = os.path.join(st.session_state.temp_dir, f"scene_{idx}_final.mp4")
            
            if st.button(f"Generate Scene {idx+1}", disabled=not can_generate, key=f"gen_btn_{idx}"):
                with st.spinner(f"Generating video for Scene {idx+1} using Veo..."):
                    try:
                        generate_scene_video(
                            current_prompt, 
                            img_to_use, 
                            final_scene_vid,
                            aspect_ratio=aspect_ratio,
                            duration_seconds=duration,
                            resolution=resolution,
                            video_model=video_model
                        )
                        # Ensure we invalidate any downstream images since the parent video changed
                        for j in range(idx+1, len(st.session_state.scenes)):
                            base_extracted_img_j = os.path.join(st.session_state.temp_dir, f"scene_{j}_from_prev.png")
                            shifted_img_j = os.path.join(st.session_state.temp_dir, f"scene_{j}_shifted.png")
                            if os.path.exists(base_extracted_img_j): os.remove(base_extracted_img_j)
                            if os.path.exists(shifted_img_j): os.remove(shifted_img_j)
                        st.rerun()
                    except Exception as e:
                        st.error(f"Error generating video: {e}")
                        
            if not os.path.exists(final_scene_vid):
                all_generated = False
                        
        with col2:
            if os.path.exists(final_scene_vid):
                st.subheader("Generated Output")
                st.video(final_scene_vid)
                st.success("Video generated!")
                
        st.markdown("---")
        
    if all_generated:
        st.success("All scenes generated! You can now stitch them into a final video.")
        if st.button("Stitch All Videos", type="primary"):
            with st.spinner("Stitching videos..."):
                final_path = os.path.join(st.session_state.temp_dir, "final_video.mp4")
                vids_to_stitch = [os.path.join(st.session_state.temp_dir, f"scene_{i}_final.mp4") for i in range(len(st.session_state.scenes))]
                try:
                    stitch_videos(vids_to_stitch, final_path)
                    st.session_state.final_video_path = final_path
                    next_step()
                    st.rerun()
                except Exception as e:
                    st.error(f"Error stitching videos: {e}")
# Step 4: Final Video
elif st.session_state.step == 4:
    st.header("Step 4: Final Video")
    st.video(st.session_state.final_video_path)
    
    with open(st.session_state.final_video_path, "rb") as f:
        st.download_button(
            label="Download Final Video",
            data=f,
            file_name="final_ugc_video.mp4",
            mime="video/mp4"
        )
        
    if st.button("Start Over"):
        reset()
        st.rerun()
