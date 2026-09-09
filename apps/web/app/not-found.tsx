export default function NotFound() {
  return <main className="wrap error-page">
    <p className="eyebrow">404 · Not available</p>
    <h1>A little off course.</h1>
    <p>This page may be private, may have moved, or may not exist. Your next stop is up to you.</p>
    <div className="hero-actions"><a className="button" href="/">Back to overview</a><a className="button secondary" href="/settings">My settings</a></div>
  </main>;
}
