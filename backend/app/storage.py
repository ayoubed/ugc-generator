import os
import mimetypes
import uuid
import urllib.parse
from datetime import timedelta
from typing import Optional
import firebase_admin
from firebase_admin import storage


def get_bucket():
    """Returns the configured Firebase Storage / GCS bucket."""
    bucket_name = os.environ.get("FIREBASE_STORAGE_BUCKET") or os.environ.get("GCS_BUCKET")
    if bucket_name:
        return storage.bucket(bucket_name)
    return storage.bucket()


def upload_file(local_path: str, storage_path: str, content_type: Optional[str] = None) -> str:
    """
    Uploads a local file to Firebase Storage.
    Returns the storage path.
    """
    if not os.path.exists(local_path):
        raise FileNotFoundError(f"Local file does not exist: {local_path}")

    bucket = get_bucket()
    blob = bucket.blob(storage_path)

    if not content_type:
        guessed_type, _ = mimetypes.guess_type(local_path)
        content_type = guessed_type or "application/octet-stream"

    # Attach Firebase Storage download token so client SDKs can read the media
    download_token = str(uuid.uuid4())
    blob.metadata = {"firebaseStorageDownloadTokens": download_token}

    blob.upload_from_filename(local_path, content_type=content_type)
    return storage_path


def download_file(storage_path: str, local_path: str) -> str:
    """
    Downloads a file from Firebase Storage to local_path.
    Creates parent directories if necessary.
    Returns the local path.
    """
    os.makedirs(os.path.dirname(os.path.abspath(local_path)), exist_ok=True)
    bucket = get_bucket()
    blob = bucket.blob(storage_path)
    if not blob.exists():
        raise FileNotFoundError(f"File not found in storage: {storage_path}")

    blob.download_to_filename(local_path)
    return local_path


def get_download_url(storage_path: str) -> str:
    """
    Returns an accessible download URL for the given storage path.
    Tries signed URL first; falls back to Firebase download token URL or public URL.
    """
    bucket = get_bucket()
    blob = bucket.blob(storage_path)

    # 1. Try signed URL (valid for 7 days)
    try:
        return blob.generate_signed_url(expiration=timedelta(days=7), method="GET")
    except Exception:
        pass

    # 2. Try Firebase Storage token URL
    try:
        if blob.exists():
            blob.reload()
            token = blob.metadata.get("firebaseStorageDownloadTokens") if blob.metadata else None
            if not token:
                token = str(uuid.uuid4())
                metadata = blob.metadata or {}
                metadata["firebaseStorageDownloadTokens"] = token
                blob.metadata = metadata
                blob.patch()

            encoded_name = urllib.parse.quote(blob.name, safe="")
            return f"https://firebasestorage.googleapis.com/v0/b/{bucket.name}/o/{encoded_name}?alt=media&token={token}"
    except Exception:
        pass

    # 3. Fallback to standard public URL or gs URI
    if blob.public_url:
        return blob.public_url
    return f"gs://{bucket.name}/{storage_path}"


def delete_file(storage_path: str) -> bool:
    """Deletes one file. Returns False (and stays quiet) when it is already gone."""
    try:
        get_bucket().blob(storage_path).delete()
        return True
    except Exception:
        return False


def delete_prefix(prefix: str) -> int:
    """Deletes every file under a folder (e.g. a removed scene's takes). Returns how many were deleted."""
    if not prefix or not prefix.endswith("/"):
        raise ValueError("delete_prefix needs a folder path ending in '/'.")
    count = 0
    for blob in get_bucket().list_blobs(prefix=prefix):
        try:
            blob.delete()
            count += 1
        except Exception:
            pass
    return count


def token_url(blob) -> str:
    """A download URL that does not expire (the kind the Firebase client SDK hands out)."""
    blob.reload()
    metadata = dict(blob.metadata or {})
    token = metadata.get("firebaseStorageDownloadTokens")
    if not token:
        token = str(uuid.uuid4())
        metadata["firebaseStorageDownloadTokens"] = token
        blob.metadata = metadata
        blob.patch()
    encoded_name = urllib.parse.quote(blob.name, safe="")
    return f"https://firebasestorage.googleapis.com/v0/b/{blob.bucket.name}/o/{encoded_name}?alt=media&token={token}"


def copy_file(source_path: str, target_path: str) -> str:
    """Copies a file inside the bucket and returns a non-expiring download URL for the copy."""
    bucket = get_bucket()
    source = bucket.blob(source_path)
    copy = bucket.copy_blob(source, bucket, target_path)
    # The copy gets its own token, so the two files can be shared and deleted independently.
    copy.metadata = {"firebaseStorageDownloadTokens": str(uuid.uuid4())}
    copy.patch()
    return token_url(copy)


def set_download_name(storage_path: str, file_name: str) -> None:
    """Makes a browser save the file under `file_name` instead of opening it or naming it by its path."""
    safe = "".join(c for c in file_name if c.isalnum() or c in "-_. ") or "download"
    blob = get_bucket().blob(storage_path)
    blob.content_disposition = f'attachment; filename="{safe}"'
    blob.patch()
