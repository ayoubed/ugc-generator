from fastapi import APIRouter
from app.model_registry import models_payload

router = APIRouter()


@router.get("/models")
async def list_models():
    """The video and script models the app offers, with what each supports. No auth: nothing private here."""
    return models_payload()
