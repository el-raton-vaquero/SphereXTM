import type { Metadata } from 'next';
import SongApp from '../../components/song/SongApp';
import { en } from '../../lib/i18n/en';
import '../../components/song/song.css';

export const metadata: Metadata = {
  title: en.song.metaTitle,
  description: en.song.metaDescription,
};

export default function Page() {
  return <SongApp />;
}
