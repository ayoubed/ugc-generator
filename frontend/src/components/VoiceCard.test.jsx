import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VoiceCard from './VoiceCard';
import { updateProjectSettings } from '../hooks/useProject';
import { previewVoice } from '../services/api';

const service = { available: true, voices: [], loading: false, error: '' };
vi.mock('../hooks/useVoices', () => ({ useVoices: () => service }));
vi.mock('../hooks/useProject', () => ({ updateProjectSettings: vi.fn(async () => {}) }));
vi.mock('../services/api', () => ({ previewVoice: vi.fn(async () => ({})) }));

const VOICES = [
  { id: 'v1', name: 'Rachel', description: 'female, young', previewUrl: 'https://x.test/rachel.mp3' },
  { id: 'v2', name: 'Adam', description: '', previewUrl: '' },
];
const project = (voice) => ({ id: 'p1', settings: voice === undefined ? {} : { voice } });

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(service, { available: true, voices: VOICES, loading: false, error: '' });
});

describe('Voice for the whole video', () => {
  it('is not offered when the server has no voice service', () => {
    Object.assign(service, { available: false, voices: [] });
    const { container } = render(<VoiceCard project={project()} />);
    expect(container.innerHTML).toBe('');
  });

  it('keeps each scene’s own voice until one is picked', () => {
    render(<VoiceCard project={project()} />);
    const select = screen.getByLabelText('Voice for the whole video');
    expect(select.value).toBe('');
    expect([...select.options].map((o) => o.textContent)).toEqual(['Each scene\'s own voice', 'Rachel (female, young)', 'Adam']);
    expect(screen.getByText(/Nothing is changed/)).toBeTruthy();
    expect(document.querySelector('audio')).toBeNull();
  });

  it('saves the picked voice with its name', async () => {
    render(<VoiceCard project={project()} />);
    await userEvent.selectOptions(screen.getByLabelText('Voice for the whole video'), 'v1');
    expect(updateProjectSettings).toHaveBeenCalledWith('p1', { voice: { id: 'v1', name: 'Rachel' } });
  });

  it('prepares the voice for the editor as soon as it is picked, and not when it is switched off', async () => {
    const { unmount } = render(<VoiceCard project={project()} />);
    await userEvent.selectOptions(screen.getByLabelText('Voice for the whole video'), 'v1');
    expect(previewVoice).toHaveBeenCalledWith('p1');
    unmount();
    vi.clearAllMocks();
    render(<VoiceCard project={project({ id: 'v1', name: 'Rachel' })} />);
    await userEvent.selectOptions(screen.getByLabelText('Voice for the whole video'), '');
    expect(previewVoice).not.toHaveBeenCalled();
  });

  it('shows the chosen voice with a sample and what to watch for', () => {
    render(<VoiceCard project={project({ id: 'v1', name: 'Rachel' })} />);
    expect(screen.getByLabelText('Voice for the whole video').value).toBe('v1');
    expect(screen.getByLabelText('Sample of Rachel').getAttribute('src')).toBe('https://x.test/rachel.mp3');
    expect(screen.getByText(/You can hear it in the editor below once it is prepared/)).toBeTruthy();
  });

  it('says while the voice is loading for the editor, and how far it is', () => {
    const loading = { ...project({ id: 'v1', name: 'Rachel' }), voicePreview: { voiceId: 'v1', status: 'building', scenes: { 0: {}, 1: {} } } };
    const { unmount } = render(<VoiceCard project={loading} />);
    expect(screen.getByText(/Loading this voice for the editor: 2 scenes ready so far\./)).toBeTruthy();
    unmount();
    render(<VoiceCard project={{ ...loading, voicePreview: { ...loading.voicePreview, status: 'ready' } }} />);
    expect(screen.queryByText(/Loading this voice/)).toBeNull();
  });

  it('goes back to each scene’s own voice', async () => {
    render(<VoiceCard project={project({ id: 'v1', name: 'Rachel' })} />);
    await userEvent.selectOptions(screen.getByLabelText('Voice for the whole video'), '');
    expect(updateProjectSettings).toHaveBeenCalledWith('p1', { voice: null });
  });

  it('keeps a saved voice the account no longer lists', () => {
    render(<VoiceCard project={project({ id: 'gone', name: 'Old voice' })} />);
    const select = screen.getByLabelText('Voice for the whole video');
    expect(select.value).toBe('gone');
    expect([...select.options].map((o) => o.textContent)).toContain('Old voice');
  });

  it('warns when a voice is chosen but the service is gone, and still lets you switch it off', async () => {
    Object.assign(service, { available: false, voices: [] });
    render(<VoiceCard project={project({ id: 'v1', name: 'Rachel' })} />);
    expect(screen.getByRole('alert').textContent).toMatch(/not set up on the server.*Stitching with this voice will fail/);
    const select = screen.getByLabelText('Voice for the whole video');
    expect(select.disabled).toBe(false);
    await userEvent.selectOptions(select, '');
    expect(updateProjectSettings).toHaveBeenCalledWith('p1', { voice: null });
  });

  it('says why the voices could not be loaded', () => {
    Object.assign(service, { available: false, voices: [], error: 'The voice service rejected its key.' });
    render(<VoiceCard project={project()} />);
    expect(screen.getByRole('alert').textContent).toBe('The voice service rejected its key.');
    expect(screen.getByLabelText('Voice for the whole video').disabled).toBe(true);
  });

  it('cannot be changed while a stitch is running', () => {
    render(<VoiceCard project={project()} disabled />);
    expect(screen.getByLabelText('Voice for the whole video').disabled).toBe(true);
  });

  it('shows a save that failed', async () => {
    updateProjectSettings.mockRejectedValueOnce(new Error('offline'));
    render(<VoiceCard project={project()} />);
    await userEvent.selectOptions(screen.getByLabelText('Voice for the whole video'), 'v2');
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});
