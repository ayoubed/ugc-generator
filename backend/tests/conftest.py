"""Shared test setup. Tests never reach Firebase, Gemini or the network."""
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Each test sets the access settings it needs; nothing leaks in from backend/.env."""
    monkeypatch.delenv("MOCK_AUTH", raising=False)
    monkeypatch.delenv("ALLOWED_EMAILS", raising=False)
    yield


class FakeSnapshot:
    def __init__(self, doc_id, data, reference=None):
        self.id = doc_id
        self._data = data
        self.exists = data is not None
        self.reference = reference

    def to_dict(self):
        return None if self._data is None else dict(self._data)


class FakeDocument:
    """One Firestore document held in memory. `update` understands dotted paths, like Firestore."""

    def __init__(self, store, path):
        self._store = store
        self.path = path
        self.id = path.split("/")[-1]

    def get(self):
        return FakeSnapshot(self.id, self._store.get(self.path), self)

    def set(self, data, merge=False):
        self._store[self.path] = {**(self._store.get(self.path) or {}), **data} if merge else dict(data)

    def update(self, data):
        doc = self._store.setdefault(self.path, {})
        for key, value in data.items():
            target = doc
            *parents, last = key.split(".")
            for part in parents:
                target = target.setdefault(part, {})
            target[last] = value

    def delete(self):
        self._store.pop(self.path, None)

    def collection(self, name):
        return FakeCollection(self._store, f"{self.path}/{name}")


class FakeCollection:
    def __init__(self, store, path):
        self._store = store
        self.path = path

    def document(self, doc_id="auto"):
        return FakeDocument(self._store, f"{self.path}/{doc_id}")

    def stream(self):
        depth = self.path.count("/") + 1
        for path in sorted(self._store):
            if path.startswith(self.path + "/") and path.count("/") == depth:
                yield FakeDocument(self._store, path).get()


class FakeBatch:
    def __init__(self):
        self._writes = []

    def set(self, ref, data, merge=False):
        self._writes.append(lambda: ref.set(data, merge=merge))

    def update(self, ref, data):
        self._writes.append(lambda: ref.update(data))

    def delete(self, ref):
        self._writes.append(ref.delete)

    def commit(self):
        for write in self._writes:
            write()


class FakeFirestore:
    """Enough of the Firestore client for the routes and helpers under test."""

    def __init__(self, documents=None):
        self.store = dict(documents or {})

    def collection(self, name):
        return FakeCollection(self.store, name)

    def batch(self):
        return FakeBatch()


@pytest.fixture
def fake_db(monkeypatch):
    from firebase_admin import firestore

    db = FakeFirestore()
    monkeypatch.setattr(firestore, "client", lambda: db)
    return db


@pytest.fixture
def api(fake_db, monkeypatch):
    """
    The API with a signed-in user "u1" and the in-memory database. Background jobs are recorded in
    `api.started` instead of run. The app's startup (which connects to Firebase) is not run.
    """
    from fastapi.testclient import TestClient

    import app.main as main
    from app import jobs
    from app.auth import get_current_user
    from app.routes import music, package, projects, reference, voices

    user = {"uid": "u1", "email": "ana@example.com", "name": "Ana", "has_access_claim": True}
    main.app.dependency_overrides[get_current_user] = lambda: user
    started = []

    def record(coro):
        started.append(coro.cr_code.co_name)
        coro.close()

    for module in (jobs, music, package, projects, reference, voices):
        monkeypatch.setattr(module, "spawn_background", record, raising=False)

    client = TestClient(main.app)
    client.user = user
    client.db = fake_db
    client.started = started
    yield client
    main.app.dependency_overrides.clear()
