import { redirect } from 'next/navigation';

// The 3D landing now lives at '/'. Keep old links working.
export default function CosmosPage() {
  redirect('/');
}
