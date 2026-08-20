import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { AgentAvatar, faceSrc } from './AgentAvatar.js';

/**
 * `faceSrc` and `OfficeState` moved here from `office-data.ts` when the legacy
 * office surfaces were deleted — this component is their only reader. These
 * cases came with them: the URL rule is a security boundary, not a nicety.
 */
describe('faceSrc', () => {
  it('asks Slack for the 48px original rather than a downscaled smudge', () => {
    expect(faceSrc('https://cdn.example/ava_192.png')).toBe('https://cdn.example/ava_48.png');
    expect(faceSrc('https://cdn.example/ava.png')).toBe('https://cdn.example/ava.png');
    expect(faceSrc('data:image/png;base64,abc')).toBe('data:image/png;base64,abc');
  });

  it('drops anything that is not a plain https/data image URL rather than interpolating it', () => {
    expect(faceSrc(null)).toBe('');
    expect(faceSrc(undefined)).toBe('');
    expect(faceSrc('javascript:alert(1)')).toBe('');
    expect(faceSrc('"><img src=x>')).toBe('');
    expect(faceSrc('http://cdn.example/ava.png')).toBe('');
  });
});

describe('AgentAvatar', () => {
  it('emits only a src faceSrc validated', () => {
    const { container } = render(<AgentAvatar name="Ava" avatarUrl="javascript:alert(1)" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-fallback="true"]')!.textContent).toBe('A');
  });

  it('takes a two-letter monogram from the caller, and draws the state dot only when asked', () => {
    const { container } = render(<AgentAvatar name="ava dev" initials="AD" status="blocked" />);
    expect(container.querySelector('[data-fallback="true"]')!.textContent).toBe('AD');
    expect(container.querySelector('[data-status="blocked"]')).toBeTruthy();
    const { container: noDot } = render(<AgentAvatar name="ava" />);
    expect(noDot.querySelector('.tm-avatar-dot')).toBeNull();
  });
});
