export const TRACK_COLORS = ['#ff6b9d', '#ffb84d', '#ffe45c', '#5ce2a0', '#5cc8ff', '#b8a4ff', '#ff8ad6', '#ff7a6e'];

// Phase 3 demo: only entries referencing real loadable plugins survive.
// `generator: null` everywhere except t1, which gets a com.noa.sine instance.
// `params: []` is the "needs hydration" placeholder; the engine boot fills it
// with the plugin manifest's defaults once registered.
export const DEMO_TRACKS = [
  { id: 't1', name: 'Kick',  type: 'midi',  color: 0,
    // Params match com.noa.sine's manifest defaults: Volume=0.5, Octave=0.
    generator: { id: 'i_sine', pluginId: 'com.noa.sine', bypass: false, params: [0.5, 0] },
    channel: 1, mute: false, solo: false, vol: 0.82 },
  { id: 't2', name: 'Snare', type: 'midi',  color: 1, generator: null, channel: 2, mute: false, solo: false, vol: 0.74 },
  { id: 't3', name: 'Hats',  type: 'midi',  color: 2, generator: null, channel: 3, mute: false, solo: false, vol: 0.62 },
  { id: 't4', name: 'Bass',  type: 'midi',  color: 3, generator: null, channel: 4, mute: false, solo: false, vol: 0.78 },
  { id: 't5', name: 'Pad',   type: 'midi',  color: 4, generator: null, channel: 5, mute: false, solo: false, vol: 0.55 },
  { id: 't6', name: 'Lead',  type: 'midi',  color: 5, generator: null, channel: 6, mute: false, solo: false, vol: 0.68 },
  { id: 't7', name: 'Arp',   type: 'midi',  color: 6, generator: null, channel: 7, mute: false, solo: false, vol: 0.58 },
  { id: 't8', name: 'Vox',   type: 'audio', color: 7, generator: null, channel: 8, mute: false, solo: false, vol: 0.72 },
];

const midiPattern = (notes) => ({ notes });

const KICK_PATTERN  = midiPattern([[0,12,0.5],[1,12,0.5],[2,12,0.5],[3,12,0.5]]);
const SNARE_PATTERN = midiPattern([[1,10,0.5],[3,10,0.5]]);
const HAT_PATTERN   = midiPattern(Array.from({length:8},(_,i)=>[i*0.5,7,0.25]));
const BASS_PATTERN  = midiPattern([[0,3,0.75],[1,5,0.5],[2,3,0.5],[2.75,1,0.5],[3,5,0.5]]);
const PAD_PATTERN   = midiPattern([[0,14,4],[0,17,4],[0,21,4]]);
const LEAD_PATTERN  = midiPattern([[0,17,1],[1,19,0.5],[1.5,21,0.5],[2,22,1],[3,19,1]]);
const ARP_PATTERN   = midiPattern([[0,14,0.25],[0.5,17,0.25],[1,21,0.25],[1.5,17,0.25],[2,14,0.25],[2.5,17,0.25],[3,21,0.25],[3.5,22,0.25]]);

export const DEMO_CLIPS = [
  { id:'c1',  trackId:'t1', start:0,  length:4, pattern: KICK_PATTERN, label:'Kick A' },
  { id:'c2',  trackId:'t1', start:4,  length:4, pattern: KICK_PATTERN, label:'Kick A' },
  { id:'c3',  trackId:'t1', start:8,  length:4, pattern: KICK_PATTERN, label:'Kick A' },
  { id:'c4',  trackId:'t1', start:16, length:4, pattern: KICK_PATTERN, label:'Kick A' },
  { id:'c5',  trackId:'t1', start:20, length:4, pattern: KICK_PATTERN, label:'Kick A' },
  { id:'c6',  trackId:'t1', start:24, length:4, pattern: KICK_PATTERN, label:'Kick A' },
  { id:'c7',  trackId:'t2', start:4,  length:4, pattern: SNARE_PATTERN, label:'Snare' },
  { id:'c8',  trackId:'t2', start:8,  length:4, pattern: SNARE_PATTERN, label:'Snare' },
  { id:'c9',  trackId:'t2', start:20, length:4, pattern: SNARE_PATTERN, label:'Snare' },
  { id:'c10', trackId:'t2', start:24, length:4, pattern: SNARE_PATTERN, label:'Snare' },
  { id:'c11', trackId:'t3', start:8,  length:4, pattern: HAT_PATTERN, label:'Hats' },
  { id:'c12', trackId:'t3', start:12, length:4, pattern: HAT_PATTERN, label:'Hats' },
  { id:'c13', trackId:'t3', start:16, length:4, pattern: HAT_PATTERN, label:'Hats' },
  { id:'c14', trackId:'t3', start:20, length:4, pattern: HAT_PATTERN, label:'Hats' },
  { id:'c15', trackId:'t4', start:4,  length:4, pattern: BASS_PATTERN, label:'Bass riff' },
  { id:'c16', trackId:'t4', start:8,  length:4, pattern: BASS_PATTERN, label:'Bass riff' },
  { id:'c17', trackId:'t4', start:16, length:8, pattern: BASS_PATTERN, label:'Bass riff' },
  { id:'c18', trackId:'t5', start:0,  length:8, pattern: PAD_PATTERN,  label:'Pad chord' },
  { id:'c19', trackId:'t5', start:16, length:8, pattern: PAD_PATTERN,  label:'Pad chord' },
  { id:'c20', trackId:'t6', start:12, length:4, pattern: LEAD_PATTERN, label:'Lead hook' },
  { id:'c21', trackId:'t6', start:20, length:4, pattern: LEAD_PATTERN, label:'Lead hook' },
  { id:'c22', trackId:'t7', start:8,  length:4, pattern: ARP_PATTERN,  label:'Arp' },
  { id:'c23', trackId:'t7', start:16, length:8, pattern: ARP_PATTERN,  label:'Arp' },
  { id:'c24', trackId:'t8', start:12, length:4, audio: true, label:'Vox hook' },
  { id:'c25', trackId:'t8', start:20, length:4, audio: true, label:'Vox hook' },
];

// Master gets the one real effect (com.noa.gain). Other channels start empty —
// the Browser drag-drop or the LOAD_PLUGIN action populates them once more
// plugins exist.
export const DEMO_CHANNELS = [
  { id:'m0', name:'Master', color: null, vol: 0.85, pan: 0, mute:false, solo:false, sends:[], effects:[
    // Params match com.noa.gain's manifest default: Gain=1.0 (unity).
    { id:'i_gain', pluginId:'com.noa.gain', bypass:false, params:[1.0] }
  ]},
  { id:'m1', name:'Kick',    color: 0, vol: 0.82, pan: 0,    mute:false, solo:false, sends:['m0'], effects:[]},
  { id:'m2', name:'Snare',   color: 1, vol: 0.74, pan: -0.05, mute:false, solo:false, sends:['m0','mB'], effects:[]},
  { id:'m3', name:'Hats',    color: 2, vol: 0.62, pan: 0.18,  mute:false, solo:false, sends:['m0','mB'], effects:[]},
  { id:'m4', name:'Bass',    color: 3, vol: 0.78, pan: 0,    mute:false, solo:false, sends:['m0'], effects:[]},
  { id:'m5', name:'Pad',     color: 4, vol: 0.55, pan: -0.12, mute:false, solo:false, sends:['m0','mR'], effects:[]},
  { id:'m6', name:'Lead',    color: 5, vol: 0.68, pan: 0.10,  mute:false, solo:false, sends:['m0','mR'], effects:[]},
  { id:'m7', name:'Arp',     color: 6, vol: 0.58, pan: 0.22,  mute:false, solo:false, sends:['m0','mR'], effects:[]},
  { id:'m8', name:'Vox',     color: 7, vol: 0.72, pan: 0,    mute:false, solo:false, sends:['m0','mR'], effects:[]},
  { id:'mB', name:'Drum Bus',color: null, vol: 0.80, pan: 0, mute:false, solo:false, sends:['m0'], effects:[]},
  { id:'mR', name:'Verb Bus',color: null, vol: 0.50, pan: 0, mute:false, solo:false, sends:['m0'], effects:[]},
];

// Phase 5: the Browser's plugin list comes from the coordinator's
// `installedPlugins` (seeded with the two built-ins in projectModel.ts).
// The static catalog that used to live here is gone.

export const FILES = [
  { name:'Projects', kind:'folder', children:[
    { name:'Midnight Drive.noa',  kind:'file' },
    { name:'Lo-fi Sketch.noa',    kind:'file' },
    { name:'Synthwave Demo.noa',  kind:'file', open:true },
    { name:'Untitled 47.noa',     kind:'file' },
  ]},
  { name:'Samples', kind:'folder', children:[
    { name:'Drums', kind:'folder', children:[
      { name:'Kick 808 deep.wav', kind:'audio' },
      { name:'Kick punchy.wav',   kind:'audio' },
      { name:'Snare crisp.wav',   kind:'audio' },
      { name:'Snare lo-fi.wav',   kind:'audio' },
      { name:'Hat closed 01.wav', kind:'audio' },
      { name:'Hat open 03.wav',   kind:'audio' },
      { name:'Clap layered.wav',  kind:'audio' },
    ]},
    { name:'FX', kind:'folder', children:[
      { name:'Riser smooth.wav',  kind:'audio' },
      { name:'Impact deep.wav',   kind:'audio' },
      { name:'Vinyl crackle.wav', kind:'audio' },
    ]},
    { name:'Loops', kind:'folder' },
  ]},
  { name:'MIDI patterns', kind:'folder', children:[
    { name:'Bass groove A.mid',   kind:'midi' },
    { name:'Chord prog Cmaj.mid', kind:'midi' },
    { name:'Drumbeat 128.mid',    kind:'midi' },
  ]},
  { name:'Presets', kind:'folder' },
];
