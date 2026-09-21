import os
from google import genai
client = genai.Client(http_options={"api_version": "v1beta"}, api_key=os.environ.get("GEMINI_API_KEY"))
for m in client.models.list_models():
    if "veo" in m.name.lower() or "video" in m.name.lower():
        print(f"Model: {m.name}, Supported Methods: {m.supported_generation_methods}")
