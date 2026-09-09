"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main className="wrap error-page">
    <p className="eyebrow">Something interrupted this page</p>
    <h1>Let’s try that again.</h1>
    <p>We couldn’t load this view. Retry in a moment, or return to the overview.</p>
    <div className="hero-actions"><button className="button" onClick={reset}>Try again</button><a className="button secondary" href="/">Back to overview</a></div>
  </main>;
}
