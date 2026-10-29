import { editMusicFile } from './music';
import { sourceAudioDuration } from './source-audio';
/** Panel and MCP share the same bounds before a version is saved. */
export async function validateMusicBounds(root:string,music:{file:string;startS:number;endS?:number;gainDb:number}) {
  if(typeof music.file!=='string' || !music.file.trim() || !Number.isFinite(music.startS) || music.startS<0 || !Number.isFinite(music.gainDb) || music.gainDb < -60 || music.gainDb > 0)throw Error('Choose a music track, start and volume between -60 and 0 dB.');
  if(music.endS!==undefined && (!Number.isFinite(music.endS) || music.endS<.1))throw Error('Choose a music end of at least 0.1 seconds.');
  const file=await editMusicFile(root,music.file);
  if(!file)return; // Existing missing-file handling keeps the saved choice honest.
  const duration=await sourceAudioDuration(file);
  if(music.startS>Math.max(0,duration-.1))throw Error('Choose a start before the end of the song.');
  return duration;
}
