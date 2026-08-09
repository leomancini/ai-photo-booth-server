import React, { useCallback, useEffect, useRef, useState } from "react";
import styled from "styled-components";
import QRCode from "qrcode";
import { Page } from "./shared.jsx";

const QRWrap = styled.div`
  flex: 1;
  align-self: stretch;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #a1a1aa;
  font-size: 18px;
`;

const QRImage = styled.img`
  width: min(420px, 80vw);
`;

const FullImage = styled.img`
  background: #000;
  ${(p) =>
    p.$onDevice
      ? `
    position: fixed;
    top: 50%;
    left: 0;
    transform: translateY(-50%);
    width: 100vw;
    height: auto;
  `
      : `
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100dvh;
    object-fit: contain;
  `}
`;

const WaitingWrap = styled.div`
  flex: 1;
  align-self: stretch;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 40px;
  color: #a1a1aa;
  font-size: 32px;
`;

const Done = styled.div`
  font-size: 96px;
  line-height: 1;
`;

const Spinner = styled.div`
  width: 96px;
  height: 96px;
  border-radius: 50%;
  border: 7px solid #27272a;
  border-top-color: #fff;
  animation: spin 0.9s linear infinite;

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
`;

// Kiosk API key, provided as ?key=... in the booth URL.
const PARAMS = new URLSearchParams(window.location.search);
const KEY = PARAMS.get("key") || "";
// ?onDevice=true — the image fills the width instead of the height
// (vertical overflow is fine).
const ON_DEVICE = PARAMS.get("onDevice") === "true";

// How long the finished print stays on screen before the booth resets itself
// and shows a QR code for the next person.
const RESET_AFTER_PRINT_MS = 6000;

const PRINT_IN_FLIGHT = ["queued", "claimed", "printing"];

function BoothPage() {
  const [sessionId, setSessionId] = useState(null);
  const [qr, setQr] = useState(null);
  const [session, setSession] = useState(null);
  const [index, setIndex] = useState(0);
  const [authError, setAuthError] = useState(false);

  const startSession = useCallback(async () => {
    setSession(null);
    setIndex(0);
    setQr(null);
    try {
      const res = await fetch(`/api/session?key=${encodeURIComponent(KEY)}`, {
        method: "POST",
      });
      if (res.status === 401 || res.status === 500) {
        setAuthError(true);
        return;
      }
      const data = await res.json();
      setSessionId(data.sessionId);
      const url = `${window.location.origin}/u/${data.sessionId}`;
      setQr({
        dataUrl: await QRCode.toDataURL(url, {
          width: 640,
          margin: 1,
          color: { dark: "#ffffff", light: "#000000" },
        }),
        url,
      });
    } catch {}
  }, []);

  useEffect(() => {
    startSession();
  }, [startSession]);

  // On-device mode: no scrolling, no cursor.
  useEffect(() => {
    if (!ON_DEVICE) return;
    for (const el of [document.documentElement, document.body]) {
      el.style.overflow = "hidden";
      el.style.cursor = "none";
    }
  }, []);

  // Live session updates over WebSocket, with auto-reconnect.
  useEffect(() => {
    if (!sessionId) return;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    let socket;
    let closed = false;
    const connect = () => {
      socket = new WebSocket(
        `${proto}://${window.location.host}/ws?session=${sessionId}&key=${encodeURIComponent(KEY)}`
      );
      socket.onmessage = (e) => {
        try {
          setSession(JSON.parse(e.data));
        } catch {}
      };
      socket.onclose = () => {
        if (!closed) setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      socket?.close();
    };
  }, [sessionId]);

  const ready = session?.results?.filter((r) => r.status === "done") || [];
  const scanned = session?.status === "scanned";
  const showViewer =
    session && session.status !== "waiting" && session.status !== "scanned";

  // Print state arrives on the same WebSocket as everything else, so the booth
  // can follow a print someone started from their phone.
  const printing = ready.find((r) => PRINT_IN_FLIGHT.includes(r.print?.status));
  const printed = ready.find((r) => r.print?.status === "done");

  // Once a print lands, leave it up long enough to be read, then start a fresh
  // session so the next person walks up to a QR code. Tracking the job id keeps
  // this from firing again on every snapshot for the same print.
  const resetForJob = useRef(null);
  useEffect(() => {
    const jobId = printed?.print?.jobId;
    if (!jobId || resetForJob.current === jobId) return;
    resetForJob.current = jobId;
    const timer = setTimeout(startSession, RESET_AFTER_PRINT_MS);
    return () => clearTimeout(timer);
  }, [printed, startSession]);

  // Keep the index valid as results stream in.
  useEffect(() => {
    if (index >= ready.length) setIndex(Math.max(0, ready.length - 1));
  }, [ready.length, index]);

  // Keyboard controls: digits jump straight to an image (1 = first, 2 =
  // second, … works for any number of styles), arrows cycle, Esc starts over.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        startSession();
        return;
      }
      if (!ready.length) return;
      if (e.key === "ArrowLeft") {
        setIndex((i) => (i - 1 + ready.length) % ready.length);
      } else if (e.key === "ArrowRight") {
        setIndex((i) => (i + 1) % ready.length);
      } else {
        const digit = parseInt(e.key, 10);
        if (digit >= 1 && digit <= ready.length) setIndex(digit - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ready.length, startSession]);

  const current = ready[index];

  if (authError) {
    return (
      <Page>
        <QRWrap>Missing or invalid API key</QRWrap>
      </Page>
    );
  }

  return (
    <Page>
      {printing ? (
        <WaitingWrap>
          <Spinner />
          Printing…
        </WaitingWrap>
      ) : printed ? (
        <WaitingWrap>
          <Done>🖨️</Done>
          Take your photo!
        </WaitingWrap>
      ) : scanned ? (
        <WaitingWrap>
          <Spinner />
          Waiting for photos…
        </WaitingWrap>
      ) : !showViewer ? (
        <QRWrap>
          {qr && <QRImage src={qr.dataUrl} alt="Scan to upload photos" />}
        </QRWrap>
      ) : current ? (
        <FullImage
          $onDevice={ON_DEVICE}
          src={`/api/session/${sessionId}/image/${current.id}?key=${encodeURIComponent(KEY)}`}
          alt={current.label}
        />
      ) : (
        <WaitingWrap>
          <Spinner />
          Creating…
        </WaitingWrap>
      )}
    </Page>
  );
}

export default BoothPage;
