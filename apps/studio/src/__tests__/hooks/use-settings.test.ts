import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSettings } from '../../hooks/use-settings';

describe('useSettings — licenseAutoProvision', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('defaults licenseAutoProvision to false', () => {
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings.licenseAutoProvision).toBe(false);
  });

  it('persists and reloads licenseAutoProvision like localMode', () => {
    const { result } = renderHook(() => useSettings());

    act(() => {
      result.current.updateSettings({ licenseAutoProvision: true });
    });
    expect(result.current.settings.licenseAutoProvision).toBe(true);

    const raw = localStorage.getItem('revealui-studio-settings');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).licenseAutoProvision).toBe(true);

    const { result: reloaded } = renderHook(() => useSettings());
    expect(reloaded.current.settings.licenseAutoProvision).toBe(true);
  });
});
