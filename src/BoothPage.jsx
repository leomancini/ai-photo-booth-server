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

const FailureDetail = styled.div`
  font-size: 22px;
  color: #71717a;
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

// Measured end to end: the job is queued, the agent picks it up within a poll,
// spends about ten seconds pushing the image over Bluetooth, and only then does
// the paper start moving for its four passes -- roughly 70s from queueing to a
// photo you can pick up. The booth runs its own clock from the moment the job
// starts rather than following the printer's status, which reports "done"
// slightly before the print is out.
const PRINTING_MS = 70000;

// How long "take your photo" stays up before the booth resets itself and shows
// a QR code for the next person.
const RESET_AFTER_PRINT_MS = 8000;

// Each finished photo gets this long on screen before the next one.
const SLIDE_MS = 5000;

// How long a failed print stays on screen before the booth goes back to the
// photos, so they can try again from their phone.
const PRINT_FAILED_MS = 12000;

// The agent reports whatever the Bluetooth stack raised, which is not something
// to put in front of someone at a party. Translate the ones that actually
// happen into what a person can do about them.
function failureHint(error = "") {
  const text = String(error);
  if (/DeviceNotFound|not found/i.test(text)) {
    return "The printer is asleep or switched off";
  }
  if (/NotAvailable|powered off|adapter/i.test(text)) {
    return "Lost the connection to the printer";
  }
  if (/paper|film|empty/i.test(text)) {
    return "The printer is out of paper";
  }
  return "Try again from your phone";
}

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
  const activePrint = ready.find(
    (r) => r.print && r.print.status !== "failed"
  )?.print?.jobId;
  const failedPrint = ready.find((r) => r.print?.status === "failed")?.print;

  // Once a print starts, hold "Printing…" for a fixed minute, then tell them to
  // take their photo, then start a fresh session for the next person. Keyed on
  // the job id so repeated snapshots for the same print do not restack timers.
  const [printPhase, setPrintPhase] = useState(null);
  const printedJob = useRef(null);
  useEffect(() => {
    if (!activePrint || printedJob.current === activePrint) return;
    printedJob.current = activePrint;
    setPrintPhase("printing");
    const toReady = setTimeout(() => setPrintPhase("ready"), PRINTING_MS);
    const toReset = setTimeout(() => {
      setPrintPhase(null);
      startSession();
    }, PRINTING_MS + RESET_AFTER_PRINT_MS);
    return () => {
      clearTimeout(toReady);
      clearTimeout(toReset);
    };
  }, [activePrint, startSession]);

  // A failed print says so on the booth as well as the phone -- whoever is
  // standing here is the one who can do something about it, and otherwise the
  // booth just sits on a spinner that never resolves. The session is left
  // alone so they can retry from their phone without losing their photos.
  const failedJob = failedPrint?.jobId;
  const shownFailure = useRef(null);
  useEffect(() => {
    if (!failedJob || shownFailure.current === failedJob) return;
    shownFailure.current = failedJob;
    setPrintPhase("failed");
    const timer = setTimeout(() => setPrintPhase(null), PRINT_FAILED_MS);
    return () => clearTimeout(timer);
  }, [failedJob]);

  // Only start the slideshow once the *first* style exists, so the sequence
  // always opens on the same photo. Styles can finish in any order, but
  // `results` keeps the order they were defined in, so filtering preserves it.
  const firstReady = session?.results?.[0]?.status === "done";

  useEffect(() => {
    if (!firstReady || ready.length < 2 || printPhase) return;
    const timer = setInterval(
      () => setIndex((i) => (i + 1) % ready.length),
      SLIDE_MS
    );
    return () => clearInterval(timer);
  }, [firstReady, ready.length, printPhase]);

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

  // The booth's physical buttons are wired to the Pi, not to this browser, so
  // publish what is on screen for the Pi's button daemon to read over the
  // DevTools port: which photo is showing (so it can light that button), and
  // whether a press should be accepted at all.
  const photoIds = ready.map((r) => r.id).join(",");
  useEffect(() => {
    window.__boothState = {
      sessionId,
      photos: ready.map((r) => ({ id: r.id, label: r.label })),
      index,
      phase: printPhase,
      selectable: Boolean(firstReady && current && !printPhase),
    };
  }, [sessionId, photoIds, index, printPhase, firstReady, current]);

  if (authError) {
    return (
      <Page>
        <QRWrap>Missing or invalid API key</QRWrap>
      </Page>
    );
  }

  return (
    <Page>
      {printPhase === "printing" ? (
        <WaitingWrap>
          <Spinner />
          Printing…
        </WaitingWrap>
      ) : printPhase === "ready" ? (
        <WaitingWrap>Take your photo</WaitingWrap>
      ) : printPhase === "failed" ? (
        <WaitingWrap>
          Print failed
          <FailureDetail>{failureHint(failedPrint?.error)}</FailureDetail>
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
      ) : firstReady && current ? (
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
