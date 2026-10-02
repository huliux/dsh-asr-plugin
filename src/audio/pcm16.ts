export function pcm16Integer(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return Math.round(clamped < 0 ? clamped * 32_768 : clamped * 32_767);
}

export function pcm16Sample(value: number): number {
  return value < 0 ? value / 32_768 : value / 32_767;
}

export function quantizePcm16Sample(sample: number): number {
  return pcm16Sample(pcm16Integer(sample));
}
