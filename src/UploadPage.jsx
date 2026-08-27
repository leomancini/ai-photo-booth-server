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
  -webkit-user-select: none;
  user-select: none;
`;

const Previews = styled.div`
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  width: 100%;
  max-width: 480px;
  margin-top: 8px;
  margin-bottom: 28px;
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
  top: 2px;
  right: 2px;
  width: 32px;
  height: 32px;
  border: none;
  background: none;
  padding: 0;
  color: #fff;
  font-size: 26px;
  line-height: 1;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
  cursor: pointer;
`;

const AddButton = styled(Button)`
  margin-top: 0;
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
  font-size: 22px;
  font-weight: 600;
`;

const MAX_PHOTOS = 3;

function UploadPage({ sessionId }) {
  const [photos, setPhotos] = useState([]);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);
  const input = useRef(null);

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

  // The finished photos only appear on the kiosk; printing happens with the
  // booth's physical buttons.
  if (sent) {
    return (
      <Page>
        <Centered>
          <Done>Look up!</Done>
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
            {photos.length ? "Add more photos" : "Choose up to 3 photos"}
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
