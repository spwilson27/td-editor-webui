const ACCENT = '#3d6fb4';

interface TabsProps<T extends string> {
  label: string; tabs: [T, string][]; value: T; onChange: (v: T) => void; borderTop?: boolean;
}

export function Tabs<T extends string>({ label, tabs, value, onChange }: TabsProps<T>) {
  return (
    <div role="tablist" aria-label={label} style="display:flex;height:30px;flex:none;background:#262626;border-bottom:1px solid #1a1a1a">
      {tabs.map(([id, text]) => {
        const on = id === value;
        return (
          <button key={id} role="tab" aria-selected={on} onClick={() => onChange(id)}
            style={`padding:0 14px;color:${on ? '#ffffff' : '#a8a8a8'};background:${on ? '#2b2b2b' : 'transparent'};box-shadow:inset 0 -2px 0 ${on ? ACCENT : 'transparent'}`}>
            {text}
          </button>
        );
      })}
    </div>
  );
}
