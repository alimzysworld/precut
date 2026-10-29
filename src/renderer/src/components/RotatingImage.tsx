import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentProps } from 'react';
import type { Clip } from '../../../shared/schema';
import { clipRotation, proxyRotation, quarterTurn } from '../../../shared/media';
import { desiredRotation, rotationRevision, subscribeRotation } from './clipRotation';

/** Keep each loaded URL's baked orientation until its successor loads. */
export function RotatingImage({ root, clip, baked, style, ...props }: ComponentProps<'img'> & { root: string; clip?: Clip; baked?: number }) {
  useSyncExternalStore(subscribeRotation, rotationRevision);
  const image = useRef<HTMLImageElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const receipt = useRef({ src: props.src, baked: baked ?? proxyRotation(clip?.proxy, clip?.meta?.containerRotation ?? clip?.meta?.rotation) });
  if (receipt.current.src !== props.src) receipt.current = { src: props.src, baked: baked ?? proxyRotation(clip?.proxy, clip?.meta?.containerRotation ?? clip?.meta?.rotation) };
  const turn = clip ? quarterTurn(desiredRotation(root, clip.id, clipRotation(clip)) - receipt.current.baked) : 0;
  useLayoutEffect(() => {
    const parent = image.current?.parentElement;
    if (!parent) return;
    const measure = () => setSize({ width: parent.clientWidth, height: parent.clientHeight });
    measure(); const observer = new ResizeObserver(measure); observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  return <img {...props} ref={image} data-picture-turn={turn} style={{ ...style, ...(turn ? {
    position: 'absolute', left: '50%', top: '50%', width: turn % 180 ? size.height : size.width,
    height: turn % 180 ? size.width : size.height, maxWidth: 'none', transform: `translate(-50%, -50%) rotate(${turn}deg)`,
  } : {}) }} />;
}
