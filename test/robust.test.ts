import { describe, expect, it } from 'vitest';
import { parseActionResult } from '../src/services/robust';

describe('parseActionResult (Robust OSDMap JSON)', () => {
  it('reads IsOK / ErrorMessage', () => {
    expect(parseActionResult('{"IsOK":true,"ErrorMessage":"","Data":{}}')).toEqual({ isOk: true, errorMessage: null });
    expect(parseActionResult('{"IsOK":false,"ErrorMessage":"Parameter \'first\' is missing."}')).toEqual({
      isOk: false,
      errorMessage: "Parameter 'first' is missing.",
    });
  });

  it('ignores key casing, a BOM and string booleans', () => {
    expect(parseActionResult('﻿{"isOK":"true","errorMessage":""}')).toEqual({ isOk: true, errorMessage: null });
  });

  it('returns null for a body that is not a JSON object', () => {
    expect(parseActionResult('<html>Not found</html>')).toBeNull();
    expect(parseActionResult('')).toBeNull();
    expect(parseActionResult('[1]')).toBeNull();
  });
});
