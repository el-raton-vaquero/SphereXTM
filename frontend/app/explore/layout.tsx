import type { Metadata } from 'next';
import '../prism-tokens.css';
import './explore.css';

export const metadata: Metadata = {
  title: 'PRISM · SPHEREx',
  description: 'Every SPHEREx frame is a different colour. PRISM separates colour from motion — real IRSA SPHEREx observations, catalogue predictions labelled as such.',
};

export default function PrismLayout({ children }: { children: React.ReactNode }) {
  return <div className="prism-root">{children}</div>;
}
