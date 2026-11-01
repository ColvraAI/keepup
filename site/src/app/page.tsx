import { App } from '@/components/App';
import { loadBundle } from '@/lib/bundle';

export default function Page() {
  return (
    <>
      <noscript>keepup’s dashboard needs JavaScript. Every number on it is in site/data.</noscript>
      <App bundle={loadBundle()} />
    </>
  );
}
