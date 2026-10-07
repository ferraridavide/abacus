import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useStore } from '../store';

export function TagInput({
  value,
  onAdd,
  onRemove,
  placeholder = 'Add tag…',
}: {
  value: string[];
  onAdd: (tag: string) => void;
  onRemove?: (tag: string) => void;
  placeholder?: string;
}) {
  const all = useStore((s) => s.tags);
  const [text, setText] = useState('');
  const [focus, setFocus] = useState(false);
  const [hi, setHi] = useState(-1); // highlighted suggestion, -1 = none

  const suggestions = useMemo(() => {
    const t = text.trim().toLowerCase();
    const have = new Set(value.map((v) => v.toLowerCase()));
    return all
      .filter((x) => !have.has(x.name.toLowerCase()) && (!t || x.name.toLowerCase().includes(t)))
      .slice(0, 8);
  }, [all, text, value]);

  const commit = (tag: string) => {
    const t = tag.trim().replace(/^#/, '');
    if (t && !value.some((v) => v.toLowerCase() === t.toLowerCase())) onAdd(t);
    setText('');
    setHi(-1);
  };

  return (
    <div className="tag-input">
      <div className="tag-chips">
        {value.map((t) => (
          <span key={t} className="tag-chip">
            #{t}
            {onRemove && (
              <button onClick={() => onRemove(t)} title="Remove tag">
                <X size={11} />
              </button>
            )}
          </span>
        ))}
        <input
          value={text}
          placeholder={value.length ? '' : placeholder}
          onChange={(e) => {
            setText(e.target.value);
            setHi(-1);
          }}
          onFocus={() => setFocus(true)}
          onBlur={() => setTimeout(() => setFocus(false), 120)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
              if (!text.trim() && e.key === 'Tab') return;
              e.preventDefault();
              commit(hi >= 0 && suggestions[hi] ? suggestions[hi].name : text);
            } else if (e.key === 'Backspace' && !text && value.length && onRemove) {
              onRemove(value[value.length - 1]);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setHi((h) => Math.min(suggestions.length - 1, h + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHi((h) => Math.max(-1, h - 1));
            } else if (e.key === 'Escape') {
              e.currentTarget.blur();
            }
          }}
        />
      </div>
      {focus && suggestions.length > 0 && (
        <div className="tag-suggest">
          {suggestions.map((s, i) => (
            <button
              key={s.name}
              className={i === hi ? 'hi' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                commit(s.name);
              }}
              onMouseEnter={() => setHi(i)}
            >
              <span>#{s.name}</span>
              <span className="dim">{s.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
