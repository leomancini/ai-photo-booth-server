import React, { useEffect, useRef, useState } from "react";
import styled from "styled-components";
import { Page, Button, ErrorMsg, compressImage } from "./shared.jsx";

const Centered = styled.div`
  flex: 1;
  align-self: stretch;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
`;

const Previews = styled.div`
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  width: 100%;
  max-width: 480px;
  margin-top: 8px;
`;

const Preview = styled.div`
  position: relative;
  aspect-ratio: 1;
  border-radius: 14px;
  overflow: hidden;
  background: #1a1a1f;

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
`;

const Remove = styled.button`
  position: absolute;
  top: 6px;
  right: 6px;
  width: 26px;
  height: 26px;
  border: none;
  background: none;
  padding: 0;
  color: #fff;
  font-size: 20px;
  line-height: 1;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
  cursor: pointer;
`;

const AddButton = styled(Button)`
  width: 100%;
  max-width: 480px;
  background: ${(p) => (p.disabled ? "#1a1a1f" : "#27272a")};
  color: ${(p) => (p.disabled ? "#3f3f46" : "#f4f4f5")};

  &:hover:enabled {
    background: #3f3f46;
  }
`;

const SubmitButton = styled(Button)`
  width: 100%;
  max-width: 480px;
  margin-top: 12px;
`;

const Done = styled.div`
  font-size: 84px;
`;

const ResultsWrap = styled.div`
  display: flex;
  flex-direction: column;
  gap: 18px;
  width: 100%;
  max-width: 480px;
`;

const ResultCard = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-radius: 16px;
  overflow: hidden;
  background: #1a1a1f;
  padding-bottom: 12px;

  img {
    width: 100%;
    display: block;
  }
`;

const ResultLabel = styled.div`
  padding: 0 14px;
  color: #a1a1aa;
  font-size: 15px;
`;

const PrintButton = styled(Button)`
  margin: 0 14px;
  background: ${(p) => (p.disabled ? "#1a1a1f" : "#f4f4f5")};
  color: ${(p) => (p.disabled ? "#52525b" : "#18181b")};
`;

const Waiting = styled.div`
  color: #a1a1aa;
  font-size: 17px;
  text-align: center;
  padding: 24px 0;
`;

const MAX_PHOTOS = 3;

// What the print job status should say on the button.
const PRINT_LABELS = {
  queued: "Sending to printer",
  claimed: "Sending to printer",
  printing: "Don’t touch paper!",
  done: "Printed ✓",
  failed: "Print failed — tap to retry",
};

function UploadPage({ sessionId }) {
  const [photos, setPhotos] = useState([]);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);
  const [results, setResults] = useState([]);
  const input = useRef(null);

  // Once the photos are away, follow the session so the finished images can be
  // offered for printing. Polling rather than a WebSocket: the phone has no API
  // key, and this page is only open for a minute or two.
  useEffect(() => {
    if (!sent) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/session/${sessionId}/status`);
        if (res.ok) {
          const data = await res.json();
          if (!stop) setResults(data.results || []);
        }
      } catch {}
      if (!stop) setTimeout(tick, 2000);
    };
    tick();
    return () => {
      stop = true;
    };
  }, [sent, sessionId]);

  const requestPrint = async (styleId) => {
    setError(null);
    // Show the queued state immediately; the next poll confirms it.
    setResults((prev) =>
      prev.map((r) => (r.id === styleId ? { ...r, print: { status: "queued" } } : r))
    );
    try {
      const res = await fetch(`/api/session/${sessionId}/print`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ styleId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start the print");
    } catch (e) {
      setError(e.message);
      setResults((prev) =>
        prev.map((r) => (r.id === styleId ? { ...r, print: null } : r))
      );
    }
  };

  // Tell the kiosk the QR code was scanned.
  useEffect(() => {
    fetch(`/api/session/${sessionId}/scanned`, { method: "POST" }).catch(() => {});
  }, [sessionId]);

  const addFiles = async (fileList) => {
    const files = Array.from(fileList || [])
      .filter((f) => f.type.startsWith("image/"))
      .slice(0, MAX_PHOTOS - photos.length);
    if (!files.length) return;
    setError(null);
    const compressed = await Promise.all(files.map(compressImage));
    setPhotos((prev) =>
      [...prev, ...compressed.map((f) => ({ file: f, url: URL.createObjectURL(f) }))].slice(
        0,
        MAX_PHOTOS
      )
    );
  };

  const removePhoto = (i) =>
    setPhotos((prev) => prev.filter((_, idx) => idx !== i));

  const submit = async () => {
    if (photos.length < 1 || sending) return;
    setSending(true);
    setError(null);
    try {
      const form = new FormData();
      photos.forEach((img, i) => form.append("images", img.file, `photo-${i}.jpg`));
      const res = await fetch(`/api/session/${sessionId}/photos`, {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      setSent(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    const ready = results.filter((r) => r.status === "done");
    return (
      <Page>
        <Centered>
          {!ready.length ? (
            <>
              <Done>✅</Done>
              <Waiting>Creating your photos</Waiting>
            </>
          ) : (
            <ResultsWrap>
              {ready.map((r) => {
                const state = r.print?.status;
                const busy = state && state !== "failed";
                return (
                  <ResultCard key={r.id}>
                    <img
                      src={`/api/session/${sessionId}/preview/${r.id}`}
                      alt={r.label}
                    />
                    <ResultLabel>{r.label}</ResultLabel>
                    <PrintButton
                      disabled={!!busy}
                      onClick={() => requestPrint(r.id)}
                    >
                      {state ? PRINT_LABELS[state] || state : "Print this one"}
                    </PrintButton>
                  </ResultCard>
                );
              })}
            </ResultsWrap>
          )}
          {error && <ErrorMsg>{error}</ErrorMsg>}
        </Centered>
      </Page>
    );
  }

  return (
    <Page>
      <Centered>
        {photos.length > 0 && (
          <Previews>
            {photos.map((p, i) => (
              <Preview key={p.url}>
                <img src={p.url} alt={`Photo ${i + 1}`} />
                <Remove onClick={() => removePhoto(i)}>✕</Remove>
              </Preview>
            ))}
          </Previews>
        )}

        <input
          ref={input}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />

        {photos.length < MAX_PHOTOS && (
          <AddButton onClick={() => input.current?.click()}>
            {photos.length ? "Add more photos" : "Choose photos"}
          </AddButton>
        )}

        {photos.length >= 1 && (
          <SubmitButton disabled={sending} onClick={submit}>
            {sending ? "Sending" : "Done"}
          </SubmitButton>
        )}

        {error && <ErrorMsg>{error}</ErrorMsg>}
      </Centered>
    </Page>
  );
}

export default UploadPage;
