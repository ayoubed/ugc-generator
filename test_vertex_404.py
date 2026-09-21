import os
from google import genai
from google.genai import types

# We don't have user's real project, but we can check the URL construction if we mock it or just look at the code.
import logging
logging.basicConfig(level=logging.DEBUG)

try:
    client = genai.Client(vertexai=True, project="dummy-project", location="us-central1", http_options={"api_version": "v1beta"})
    # This will fail with auth, but we can see the URL in the debug logs if it tries to connect
    client.models.generate_content(model="gemini-1.5-pro", contents="hi")
except Exception as e:
    print("WITH V1BETA:", e)

try:
    client2 = genai.Client(vertexai=True, project="dummy-project", location="us-central1")
    client2.models.generate_content(model="gemini-1.5-pro", contents="hi")
except Exception as e:
    print("WITHOUT HTTP OPTIONS:", e)
