import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import SceneCard from './SceneCard';

vi.mock('../services/api', () => ({ resolveStorageUrl: vi.fn(async (path) => path) }));

const scene = {
  id: '1',
  description: 'She presses the pump.',
  script: 'One pump every night.',
  context: '',
  prompt: 'What They Say: One pump every night.\nWhat happens: She presses the pump.',
  imageSource: 'last_frame',
};

describe('SceneCard (Script step)', () => {
  it('shows the scene text and its own pictures', () => {
    render(<SceneCard scene={scene} sceneNumber={2} />);
    expect(screen.getByDisplayValue('One pump every night.')).toBeTruthy();
    expect(screen.getByDisplayValue('She presses the pump.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Scene pictures' })).toBeTruthy();
  });

  it('does not offer the starting picture: that is chosen on the Generate step', () => {
    render(<SceneCard scene={scene} sceneNumber={2} />);
    expect(screen.queryByRole('heading', { name: /starting picture/i })).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByText(/creator photo/i)).toBeNull();
    expect(screen.getByText(/chosen on the Generate step/i)).toBeTruthy();
  });

  it('cannot be deleted while it is making a take', () => {
    render(<SceneCard scene={{ ...scene, videoStatus: 'generating' }} sceneNumber={2} onDelete={() => {}} />);
    expect(screen.getByRole('button', { name: /delete/i }).disabled).toBe(true);
  });
});
