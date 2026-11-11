import { useState, useEffect } from 'react';
import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  serverTimestamp,
  getDocs,
} from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';
import { auth, db } from '../services/firebase';
import { sortScenes } from '../utils/projectProgress';

/**
 * Creates a new project in Firestore with status='draft'
 * @param {string} idea - Initial project idea
 * @returns {Promise<string>} Project ID
 */
export async function createProject(idea = '') {
  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error('Must be signed in to create a project');

  const cleanIdea = idea ? idea.trim() : '';
  const title = cleanIdea ? (cleanIdea.length > 50 ? cleanIdea.slice(0, 47) + '...' : cleanIdea) : 'Untitled UGC Project';

  const docRef = await addDoc(collection(db, 'projects'), {
    userId: currentUser.uid,
    status: 'draft',
    title,
    idea: cleanIdea,
    settings: {},
    startingImageRef: '',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  return docRef.id;
}

/**
 * Hook to retrieve real-time list of projects for current user
 */
export function useProjects() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let unsubscribeSnapshot = null;

    const unsubscribeAuth = onAuthStateChanged(auth, (currentUser) => {
      if (!currentUser) {
        setProjects([]);
        setLoading(false);
        if (unsubscribeSnapshot) {
          unsubscribeSnapshot();
          unsubscribeSnapshot = null;
        }
        return;
      }

      const q = query(
        collection(db, 'projects'),
        where('userId', '==', currentUser.uid)
      );

      unsubscribeSnapshot = onSnapshot(
        q,
        (snapshot) => {
          const items = snapshot.docs.map((docSnap) => ({
            id: docSnap.id,
            ...docSnap.data(),
          }));

          // Sort descending by updatedAt or createdAt
          items.sort((a, b) => {
            const timeA = a.updatedAt?.toMillis?.() || a.createdAt?.toMillis?.() || 0;
            const timeB = b.updatedAt?.toMillis?.() || b.createdAt?.toMillis?.() || 0;
            return timeB - timeA;
          });

          setProjects(items);
          setLoading(false);
        },
        (err) => {
          console.error('Error fetching projects:', err);
          setError(err);
          setLoading(false);
        }
      );
    });

    return () => {
      unsubscribeAuth();
      if (unsubscribeSnapshot) unsubscribeSnapshot();
    };
  }, []);

  return { projects, loading, error };
}

/**
 * Hook to retrieve a single project in real-time
 */
export function useProject(id) {
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(Boolean(id));
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!id) return;

    const docRef = doc(db, 'projects', id);
    const unsubscribe = onSnapshot(
      docRef,
      (snapshot) => {
        if (snapshot.exists()) {
          setProject({ id: snapshot.id, ...snapshot.data() });
        } else {
          setProject(null);
        }
        setLoading(false);
      },
      (err) => {
        console.error(`Error fetching project ${id}:`, err);
        setError(err);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [id]);

  return { project, loading, error };
}

/**
 * Hook to retrieve real-time scenes subcollection for a project
 */
export function useScenes(projectId) {
  const [scenes, setScenes] = useState([]);
  const [loading, setLoading] = useState(Boolean(projectId));
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!projectId) return;

    const scenesCol = collection(db, 'projects', projectId, 'scenes');
    const unsubscribe = onSnapshot(
      scenesCol,
      (snapshot) => {
        const items = snapshot.docs.map((docSnap) => ({
          id: docSnap.id,
          ...docSnap.data(),
        }));

        // Video order: by spot, alternatives of one spot together (see utils/projectProgress).
                setScenes(sortScenes(items));
        setLoading(false);
      },
      (err) => {
        console.error(`Error fetching scenes for project ${projectId}:`, err);
        setError(err);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [projectId]);

  return { scenes, loading, error };
}

/**
 * Update project fields allowed by Firestore security rules:
 * ['title', 'idea', 'settings', 'startingImageRef', 'globalImages', 'updatedAt']
 */
export async function updateProject(id, data) {
  const allowedKeys = ['title', 'idea', 'settings', 'startingImageRef', 'globalImages', 'updatedAt'];
  const updateData = {};

  for (const key of Object.keys(data)) {
    if (allowedKeys.includes(key)) {
      updateData[key] = data[key];
    }
  }

  updateData.updatedAt = serverTimestamp();

  const docRef = doc(db, 'projects', id);
  return updateDoc(docRef, updateData);
}

/**
 * Update only the given fields inside project.settings (e.g. { videoContext }), leaving the
 * other settings untouched. The Idea page and the Scenes page each own some settings.
 */
export async function updateProjectSettings(id, partial) {
  const updateData = { updatedAt: serverTimestamp() };
  for (const [key, value] of Object.entries(partial)) {
    updateData[`settings.${key}`] = value;
  }
  return updateDoc(doc(db, 'projects', id), updateData);
}

/**
 * Saves top-level fields (title, idea, startingImageRef) and some settings in ONE write. Each
 * setting is written on its own, so settings owned by other pages or the server (videoContext,
 * music) are never overwritten with an older copy.
 */
export async function saveProjectWithSettings(id, fields, settingsPartial) {
  const updateData = { updatedAt: serverTimestamp() };
  for (const key of ['title', 'idea', 'startingImageRef']) {
    if (key in fields) updateData[key] = fields[key];
  }
  for (const [key, value] of Object.entries(settingsPartial || {})) {
    updateData[`settings.${key}`] = value;
  }
  return updateDoc(doc(db, 'projects', id), updateData);
}

/**
 * Update scene content fields allowed by Firestore security rules:
 * ['description', 'script', 'context', 'prompt', 'imageSource', 'skipped',
 *  'sceneImages', 'customStartImageRef', 'customStartImageUrl', 'endImageRef', 'endImageUrl']
 */
export async function updateScene(projectId, sceneIndex, data) {
  const allowedKeys = [
    'description',
    'script',
    'context',
    'prompt',
    'imageSource',
    'skipped',
    'sceneImages',
    'customStartImageRef',
    'customStartImageUrl',
    'endImageRef',
    'endImageUrl',
  ];
  const updateData = {};

  for (const key of Object.keys(data)) {
    if (allowedKeys.includes(key)) {
      updateData[key] = data[key];
    }
  }

  const docRef = doc(db, 'projects', projectId, 'scenes', String(sceneIndex));
  return updateDoc(docRef, updateData);
}

/**
 * Delete a project and its scenes
 */
export async function deleteProject(id) {
  try {
    const scenesCol = collection(db, 'projects', id, 'scenes');
    const sceneSnaps = await getDocs(scenesCol);
    const deletePromises = sceneSnaps.docs.map((s) => deleteDoc(s.ref));
    await Promise.all(deletePromises);

    const docRef = doc(db, 'projects', id);
    await deleteDoc(docRef);
  } catch (err) {
    console.error(`Failed to delete project ${id}:`, err);
    throw err;
  }
}

/**
 * Delete an individual scene
 */
export async function deleteScene(projectId, sceneIndex) {
  const docRef = doc(db, 'projects', projectId, 'scenes', String(sceneIndex));
  return deleteDoc(docRef);
}
