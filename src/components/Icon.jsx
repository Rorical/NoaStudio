const ICONS = {
  play:        <path d="M8 5v14l11-7z"/>,
  pause:       <path d="M6 5h4v14H6zM14 5h4v14h-4z"/>,
  stop:        <path d="M6 6h12v12H6z"/>,
  record:      <circle cx="12" cy="12" r="6"/>,
  skip_prev:   <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/>,
  skip_next:   <path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/>,
  loop:        <path d="M7 7h9V4l5 5-5 5v-3H7v3l-5-5 5-5zm10 10H8v3l-5-5 5-5v3h9z"/>,
  metronome:   <path d="M11 2h2l5 18a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2zM10 16h4v2h-4z"/>,
  folder:      <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8z"/>,
  folder_open: <path d="M19 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6l2 2h7a2 2 0 0 1 2 2H4v10l2.14-8H23z"/>,
  file:        <path d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V9h5.5z"/>,
  audio:       <path d="M3 9v6h4l5 5V4L7 9zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/>,
  midi:        <path d="M3 5h2v14H3zm16 0h2v14h-2zM7 5h2v14H7zm4 0h2v14h-2zm4 0h2v14h-2z"/>,
  piano:       <path d="M3 3h18v18H3zm2 2v8h2v-8zm4 0v8h2v-8zm4 0v8h2v-8zm4 0v8h2v-8zM5 15v4h2v-4zm4 0v4h2v-4zm4 0v4h2v-4zm4 0v4h2v-4z"/>,
  add:         <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/>,
  search:      <path d="M10 4a6 6 0 1 1-3.79 10.66l-4.7 4.7-1.42-1.42 4.7-4.7A6 6 0 0 1 10 4zm0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/>,
  close:       <path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/>,
  more:        <circle cx="12" cy="5" r="2"/>,
  more_h:      <g><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></g>,
  chevron_d:   <path d="M7 10l5 5 5-5z"/>,
  chevron_r:   <path d="M10 7l5 5-5 5z"/>,
  chevron_l:   <path d="M14 7l-5 5 5 5z"/>,
  expand:      <path d="M5 19V5h4v2H7v2H5zm10-14h4v4h-2V7h-2zM5 19h4v-2H7v-2H5zm14 0v-4h-2v2h-2v2z"/>,
  settings:    <path d="M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm9.4 5.5-1.6-.9c.05-.4.1-.8.1-1.2s-.05-.8-.1-1.2l1.6-.9-2-3.4-1.8.7a7.5 7.5 0 0 0-2.1-1.2L15 3h-4l-.5 2.4a7.5 7.5 0 0 0-2.1 1.2l-1.8-.7-2 3.4 1.6.9a7 7 0 0 0 0 2.4l-1.6.9 2 3.4 1.8-.7a7.5 7.5 0 0 0 2.1 1.2L11 21h4l.5-2.4a7.5 7.5 0 0 0 2.1-1.2l1.8.7z"/>,
  save:        <path d="M5 3h11l4 4v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm2 2v5h8V5zm5 8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/>,
  undo:        <path d="M12 6V3L6 9l6 6v-3c3.3 0 6 2.7 6 6h2c0-4.4-3.6-8-8-8z"/>,
  redo:        <path d="M12 6V3l6 6-6 6v-3c-3.3 0-6 2.7-6 6H4c0-4.4 3.6-8 8-8z"/>,
  mute_off:    <path d="M3 9v6h4l5 5V4L7 9z"/>,
  mute_on:     <path d="M3 9v6h4l5 5V4L7 9zm14 2-3-3-1.4 1.4 3 3-3 3 1.4 1.4 3-3 3 3 1.4-1.4-3-3 3-3-1.4-1.4z"/>,
  drag:        <path d="M9 4h2v2H9zm0 5h2v2H9zm0 5h2v2H9zm0 5h2v2H9zm4-15h2v2h-2zm0 5h2v2h-2zm0 5h2v2h-2zm0 5h2v2h-2z"/>,
  visibility:  <path d="M12 5c-7 0-10 7-10 7s3 7 10 7 10-7 10-7-3-7-10-7zm0 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8z"/>,
  bolt:        <path d="M11 21h-1l1-7H7l5-11h1l-1 7h4z"/>,
  tune:        <path d="M3 17v2h6v-2zm0-7v2h10v-2zm0-7v2h14V3zm15 16v-2h3v-2h-3v-2h-2v6zm-7-9V8h-2v2H3v2h6v2h2v-2h10v-2z"/>,
  arrows:      <path d="M5 9h2V5H3v4h2zm14 0V5h-4v2h2v2h2zM5 15v2h2v2H3v-4zm14 0h2v4h-4v-2h2z"/>,
  link:        <path d="M3.9 12a4.1 4.1 0 0 1 4.1-4.1h4V6H8a6 6 0 0 0 0 12h4v-1.9H8A4.1 4.1 0 0 1 3.9 12zM8 13h8v-2H8zm8-7h-4v1.9h4a4.1 4.1 0 1 1 0 8.2h-4V18h4a6 6 0 1 0 0-12z"/>,
  bus:         <path d="M4 4h16v3H4zm0 6h16v3H4zm0 6h16v3H4z"/>,
  fader:       <path d="M11 3h2v18h-2zm-3 4h8v2H8zm0 7h8v2H8z"/>,
  output:      <path d="M14 3v2h3.6L9 13.6 10.4 15 19 6.4V10h2V3zm-4 4H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5h-2v5H5V9h5z"/>,
  edit:        <path d="M3 17.2V21h3.8l11-11-3.8-3.8zm17.7-9.6a1 1 0 0 0 0-1.4L18.4 4a1 1 0 0 0-1.4 0l-1.8 1.8 3.8 3.8z"/>,
  delete:      <path d="M6 7h12v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2zm3-4h6l1 1h4v2H4V4h4z"/>,
  drum:        <path d="M12 3C7 3 3 4.8 3 7v10c0 2.2 4 4 9 4s9-1.8 9-4V7c0-2.2-4-4-9-4zm0 2c4 0 7 1.3 7 2s-3 2-7 2-7-1.3-7-2 3-2 7-2z"/>,
  panel_left:  <path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zm2 0v14h5V5zm7 0v14h7V5z"/>,
  panel_bottom:<path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zm2 0v9h14V5zm0 11v3h14v-3z"/>,
  synth:       <path d="M2 8h20v8H2zm2 2v4h2v-4zm4 0v4h2v-4zm4 0v4h2v-4zm4 0v4h2v-4zm-9 6h2v2H7zm5 0h2v2h-2zm5 0h2v2h-2z"/>,
};

export default function Icon({ name, size = 20, ...rest }) {
  const node = ICONS[name];
  if (!node) return null;
  return (
    <svg className="icon" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" {...rest}>
      {node}
    </svg>
  );
}
