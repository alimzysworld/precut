import { useRef, useState } from 'react';
import type { Shoot } from '../../../../shared/schema';
import type { StoryboardShot } from '../../../../shared/storyboard';
import { frameSrc } from '../../data';

export function StoryboardStill({ shoot, shot, onError }: { shoot: Shoot; shot?: StoryboardShot; onError?: () => void }) {
  const src = shot?.framePath ? frameSrc(shoot.root, shot.framePath) : null;
  const requested = useRef(src);
  requested.current = src;
  const [loaded, setLoaded] = useState<{ src: string; shot: StoryboardShot } | null>(null);
  // Keep the decoded picture in place while the next DOM image becomes ready.
  // The incoming element keeps its key when promoted, so no empty image is painted.
  const previous = loaded && loaded.src !== src ? loaded : null;
  const images = src && shot ? [...(previous ? [previous] : []), { src, shot }] : [];
  return <>
    {images.map(image => <img key={image.src} src={image.src} alt={image.shot.spokenLine ?? ''} draggable={false}
      className="absolute inset-0 h-full w-full object-cover"
      style={{ objectPosition: `${image.shot.position.x * 100}% ${image.shot.position.y * 100}%`, visibility: previous && image.src === src ? 'hidden' : 'visible' }}
      onLoad={event => {
        const element = event.currentTarget;
        void element.decode().then(() => {
          if (requested.current === image.src) setLoaded(image);
        }, () => { if (requested.current === image.src) onError?.(); });
      }}
      onError={() => { if (requested.current === image.src) onError?.(); }} />)}
    {(!shot || shot.missing) && <span className="absolute inset-0 flex items-center justify-center bg-danger/20 text-small text-ink"><span className="rounded-xl bg-surface px-3 py-2">{shot?.missing ? 'Missing' : 'No supporting still yet'}</span></span>}
  </>;
}
