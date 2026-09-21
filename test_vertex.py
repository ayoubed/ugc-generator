from google import genai
try:
    client = genai.Client(vertexai=True, project="dummy-project", location="us-central1")
    print("Vertex AI Client initialization successful (or deferred authentication).")
except Exception as e:
    print(f"Error: {e}")
