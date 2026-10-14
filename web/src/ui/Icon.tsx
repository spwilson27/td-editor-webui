interface IconProps { d: string; size?: number; sw?: number; stroke?: string; style?: string }

export function Icon({ d, size = 16, sw = 1.8, stroke = 'currentColor', style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} stroke-width={sw}
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style={style}>
      <path d={d} />
    </svg>
  );
}

export const NOT_IN_VERSION = 'Not in this version';
