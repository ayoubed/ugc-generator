import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EndCardCard from './EndCardCard';
import { editEndCard } from '../services/api';
import { updateProjectSettings } from '../hooks/useProject';

vi.mock('../services/firebase', () => ({ storage: {} }));
vi.mock('firebase/storage', () => ({
  ref: vi.fn((storage, path) => ({ path })),
  uploadBytes: vi.fn(async () => {}),
  getDownloadURL: vi.fn(async (fileRef) => `https://files.test/${fileRef.path}`),
}));
vi.mock('../hooks/useProject', () => ({ updateProjectSettings: vi.fn(async () => {}) }));
vi.mock('../services/api', () => ({ editEndCard: vi.fn(async () => ({})) }));

const show = (endCard) =>
  render(<EndCardCard project={{ id: 'p1', settings: endCard ? { endCard } : {} }} storagePrefix="users/u1/projects/p1" />);
const card = { enabled: true, imageRef: 'card.png', imageUrl: 'https://files.test/card.png', seconds: 3 };

beforeEach(() => vi.clearAllMocks());

describe('End card', () => {
  it('starts with a way to add a picture, and nothing else', () => {
    show();
    expect(screen.getByRole('button', { name: 'Add a picture' })).toBeTruthy();
    expect(screen.queryByLabelText('Change the picture with a prompt')).toBeNull();
  });

  it('is a picture with a length: no headline, no smaller line', () => {
    show(card);
    expect(screen.getByAltText('End card picture').getAttribute('src')).toBe('https://files.test/card.png');
    expect(screen.getByLabelText('Shown for').value).toBe('3');
    expect(screen.queryByLabelText('Headline')).toBeNull();
    expect(screen.queryByLabelText('Smaller line')).toBeNull();
  });

  it('changes the picture with a prompt', async () => {
    show(card);
    const change = screen.getByRole('button', { name: 'Change' });
    expect(change.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Change the picture with a prompt'), 'put it on dark marble');
    await userEvent.click(change);
    expect(editEndCard).toHaveBeenCalledWith('p1', 'put it on dark marble');
    await waitFor(() => expect(screen.getByLabelText('Change the picture with a prompt').value).toBe(''));
  });

  it('says why a change failed and keeps what was typed', async () => {
    editEndCard.mockRejectedValueOnce(new Error('The model is busy.'));
    show(card);
    await userEvent.type(screen.getByLabelText('Change the picture with a prompt'), 'darker');
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The model is busy.');
    expect(screen.getByLabelText('Change the picture with a prompt').value).toBe('darker');
  });

  it('takes the last change back', async () => {
    show({ ...card, previous: { imageRef: 'before.png', imageUrl: 'https://files.test/before.png' } });
    await userEvent.click(screen.getByRole('button', { name: 'Undo the last change' }));
    expect(updateProjectSettings).toHaveBeenCalledWith('p1', {
      'endCard.imageRef': 'before.png',
      'endCard.imageUrl': 'https://files.test/before.png',
      'endCard.previous': null,
    });
  });

  it('has nothing to undo before a change', () => {
    show(card);
    expect(screen.queryByRole('button', { name: 'Undo the last change' })).toBeNull();
  });

  it('uploads a picture and switches the card on', async () => {
    const { container } = show();
    const file = new File(['x'], 'pack.png', { type: 'image/png' });
    await userEvent.upload(container.querySelector('input[type="file"]'), file);
    await waitFor(() => expect(updateProjectSettings).toHaveBeenCalled());
    const [, saved] = updateProjectSettings.mock.calls[0];
    expect(saved['endCard.imageRef']).toMatch(/^users\/u1\/projects\/p1\/end_card_\d+\.png$/);
    expect(saved['endCard.enabled']).toBe(true);
    expect(saved['endCard.previous']).toBeNull();
  });

  it('switches off and changes its length', async () => {
    show(card);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Add the end card to the video' }));
    expect(updateProjectSettings).toHaveBeenCalledWith('p1', { 'endCard.enabled': false });
    await userEvent.selectOptions(screen.getByLabelText('Shown for'), '4');
    expect(updateProjectSettings).toHaveBeenCalledWith('p1', { 'endCard.seconds': 4 });
  });
});
