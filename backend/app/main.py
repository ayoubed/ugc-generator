import os
import logging
from contextlib import asynccontextmanager
from dotenv import load_dotenv
import firebase_admin
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from pathlib import Path

# Load environment variables from backend/.env or current working directory
_backend_env = Path(__file__).resolve().parent.parent / ".env"
if _backend_env.exists():
    load_dotenv(dotenv_path=_backend_env, override=True)
load_dotenv(override=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("ugc-backend")


def init_firebase():
    """Initializes Firebase Admin SDK using application default credentials."""
    if not firebase_admin._apps:
        options = {}
        storage_bucket = os.environ.get("FIREBASE_STORAGE_BUCKET") or os.environ.get("GCS_BUCKET")
        if storage_bucket:
            options["storageBucket"] = storage_bucket

        try:
            firebase_admin.initialize_app(options=options if options else None)
            logger.info("Firebase Admin SDK initialized successfully.")
        except Exception as e:
            logger.warning(f"Could not initialize Firebase Admin SDK automatically: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Initialize Firebase Admin
    init_firebase()
    from app.jobs import remember_main_loop
    remember_main_loop()
    from app.auth import allowed_emails
    if allowed_emails():
        logger.info("API access limited to %d allowlisted account(s).", len(allowed_emails()))
    else:
        logger.warning("ALLOWED_EMAILS is not set: any Google account can sign in and generate.")
    if os.environ.get("MOCK_AUTH", "").lower() in ("1", "true"):
        logger.warning("MOCK_AUTH is on: authentication is DISABLED. Never use this outside local tests.")
    yield
    # Shutdown logic if needed


app = FastAPI(
    title="UGC Studio Backend",
    description="Backend API for UGC video generation using Gemini and Gemini Omni.",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS middleware for development
allowed_origins_env = os.environ.get("CORS_ORIGINS", "")
allowed_origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]
if allowed_origins_env:
    allowed_origins.extend([origin.strip() for origin in allowed_origins_env.split(",") if origin.strip()])

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(set(allowed_origins)),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include API routers
from app.routes.health import router as health_router
from app.routes.scenes import router as scenes_router
from app.routes.generate import router as generate_router
from app.routes.stitch import router as stitch_router
from app.routes.models import router as models_router
from app.routes.music import router as music_router
from app.routes.projects import router as projects_router
from app.routes.reference import router as reference_router
from app.routes.voices import router as voices_router
from app.routes.package import router as package_router
from app.routes.sounds import router as sounds_router
from app.routes.storyboard import router as storyboard_router
from app.routes.end_card import router as end_card_router

app.include_router(health_router, prefix="/api", tags=["Health"])
app.include_router(scenes_router, prefix="/api", tags=["Scenes"])
app.include_router(generate_router, prefix="/api", tags=["Generate"])
app.include_router(stitch_router, prefix="/api", tags=["Stitch"])
app.include_router(models_router, prefix="/api", tags=["Models"])
app.include_router(music_router, prefix="/api", tags=["Music"])
app.include_router(projects_router, prefix="/api", tags=["Projects"])
app.include_router(reference_router, prefix="/api", tags=["Reference"])
app.include_router(voices_router, prefix="/api", tags=["Voices"])
app.include_router(package_router, prefix="/api", tags=["Package"])
app.include_router(sounds_router, prefix="/api", tags=["Sounds"])
app.include_router(storyboard_router, prefix="/api", tags=["Storyboard"])
app.include_router(end_card_router, prefix="/api", tags=["End card"])
if os.environ.get("MOCK_AUTH", "").lower() in ("1", "true"):
    # Local development only: lets the frontend sign in as the test account (see routes/dev.py).
    from app.routes.dev import router as dev_router
    app.include_router(dev_router, prefix="/api", tags=["Dev"])


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 8080))
    uvicorn.run("app.main:app", host="0.0.0.0", port=port, reload=True)
