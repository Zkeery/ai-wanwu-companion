'use client';

import { useId } from 'react';
import { withBasePath } from '@/lib/base-path';
import type { Season } from '@/lib/seasons';
import styles from './gathering-room-backdrop.module.css';

const seasonCells: Record<Season, string> = {
  spring: '0 0 768 512',
  summer: '768 0 768 512',
  autumn: '0 512 768 512',
  winter: '768 512 768 512',
};

/** A fixed room illustration below the transparent, interactive companion canvas. */
export default function GatheringRoomBackdrop({ season, extraSeats = 0 }: { season: Season | null; extraSeats?: number }) {
  const instance = useId().replace(/:/g, '');
  const id = (name: string) => `${instance}-room-${name}`;
  const paint = (name: string) => `url(#${id(name)})`;
  const currentSeason = season ?? 'summer';

  return <div className={styles.layer} aria-hidden="true" data-room-art="living-room" data-room-season={currentSeason}>
    <svg className={styles.art} viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid meet" focusable="false">
      <defs>
        <linearGradient id={id('wall')} x1="0" y1="0" x2="0.5" y2="1">
          <stop stopColor="#f6ead1" /><stop offset=".6" stopColor="#ead9b8" /><stop offset="1" stopColor="#d7c29c" />
        </linearGradient>
        <linearGradient id={id('side-wall')} x1="0" y1="0" x2="1" y2=".4">
          <stop stopColor="#cfbc96" /><stop offset=".55" stopColor="#e6d6b4" /><stop offset="1" stopColor="#d9c5a1" />
        </linearGradient>
        <linearGradient id={id('ceiling')} x2="0" y2="1">
          <stop stopColor="#a48961" /><stop offset="1" stopColor="#ddc39b" />
        </linearGradient>
        <linearGradient id={id('floor')} x1=".2" y1="0" x2=".7" y2="1">
          <stop stopColor="#b38c60" /><stop offset=".46" stopColor="#d1ad7c" /><stop offset="1" stopColor="#c8a172" />
        </linearGradient>
        <linearGradient id={id('timber')} x2=".2" y2="1">
          <stop stopColor="#795335" /><stop offset=".25" stopColor="#a67b50" /><stop offset=".7" stopColor="#8c623e" /><stop offset="1" stopColor="#62452f" />
        </linearGradient>
        <linearGradient id={id('oak')} x1="0" y1="0" x2=".7" y2="1">
          <stop stopColor="#c8a06c" /><stop offset=".55" stopColor="#a87c4d" /><stop offset="1" stopColor="#795739" />
        </linearGradient>
        <linearGradient id={id('stone')} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#ddc9a6" /><stop offset=".45" stopColor="#c6b28f" /><stop offset="1" stopColor="#a28c6c" />
        </linearGradient>
        <linearGradient id={id('sofa')} x2=".1" y2="1">
          <stop stopColor="#c5c5a7" /><stop offset=".5" stopColor="#a9b295" /><stop offset="1" stopColor="#7e8d74" />
        </linearGradient>
        <linearGradient id={id('cushion')} x2="0" y2="1">
          <stop stopColor="#ece5c8" /><stop offset="1" stopColor="#ccc4a4" />
        </linearGradient>
        <linearGradient id={id('seat')} x2="0" y2="1">
          <stop stopColor="#d0d0b1" /><stop offset="1" stopColor="#9da98e" />
        </linearGradient>
        <linearGradient id={id('curtain')} x2="1" y2=".15">
          <stop stopColor="#d1c4a4" /><stop offset=".2" stopColor="#f9f0d9" /><stop offset=".4" stopColor="#e4d8bb" /><stop offset=".65" stopColor="#fff8e2" /><stop offset="1" stopColor="#cfc1a0" />
        </linearGradient>
        <linearGradient id={id('pot')} x2="1" y2=".25">
          <stop stopColor="#a36a4c" /><stop offset=".45" stopColor="#d69e73" /><stop offset="1" stopColor="#a16e4e" />
        </linearGradient>
        <linearGradient id={id('leaf')} x2="1" y2="1">
          <stop stopColor="#809466" /><stop offset=".5" stopColor="#547349" /><stop offset="1" stopColor="#344f38" />
        </linearGradient>
        <radialGradient id={id('hearth-glow')}>
          <stop stopColor="#fbd282" stopOpacity=".62" /><stop offset="1" stopColor="#e5ad68" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={id('lamp-glow')}>
          <stop stopColor="#fff0be" stopOpacity=".8" /><stop offset="1" stopColor="#fff0be" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={id('fire')} x2="0" y2="1">
          <stop stopColor="#ffe9a2" /><stop offset=".55" stopColor="#e9a955" /><stop offset="1" stopColor="#ba6b36" />
        </linearGradient>
        <pattern id={id('plaster')} width="37" height="31" patternUnits="userSpaceOnUse">
          <circle cx="3" cy="8" r=".6" fill="#8c795b" opacity=".12" /><circle cx="22" cy="20" r=".7" fill="#fff7de" opacity=".45" /><path d="m12 26 3-1m14-19 2 1" stroke="#a8926e" strokeOpacity=".13" />
        </pattern>
        <pattern id={id('weave')} width="6" height="6" patternUnits="userSpaceOnUse">
          <path d="M0 1h6M1 0v6" stroke="#fffbea" strokeWidth=".6" opacity=".18" />
        </pattern>
        <pattern id={id('stone-joints')} width="118" height="58" patternUnits="userSpaceOnUse">
          <path d="M0 0h118v58H0zM58 0v28M0 28h118M24 28v30M93 28v30" fill="none" stroke="#89775e" strokeOpacity=".37" strokeWidth="2" /><path d="M3 3h52M61 3h53M4 32h17M29 32h60M98 32h16" stroke="#f4e4c8" strokeOpacity=".56" />
        </pattern>
        <filter id={id('soft-shadow')} x="-30%" y="-30%" width="160%" height="170%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
        <clipPath id={id('window')}><path d="m72 141 177 26v215L72 411Z" /></clipPath>
        <clipPath id={id('floor-clip')}><path d="M300 465h780l120 150v185H0V625Z" /></clipPath>
      </defs>

      {/* The back corners and converging floor boards establish the room depth. */}
      <path d="M0 0h1200l-120 90H300Z" fill={paint('ceiling')} />
      <path d="M0 0 300 90v375L0 625Z" fill={paint('side-wall')} />
      <path d="M300 90h780v375H300Z" fill={paint('wall')} />
      <path d="m1080 90 120-90v625l-120-160Z" fill="#c9b58f" />
      <path d="M0 0h1200v625l-120-160H300L0 625Z" fill={paint('plaster')} />
      <path d="M300 465h780l120 160v175H0V625Z" fill={paint('floor')} />
      <g clipPath={paint('floor-clip')}>
        <path d="m300 465-300 256v45l353-301Zm114 0L170 800h113l202-335Zm144 0L478 800h102l42-335Zm135 0 74 335h108L757 465Zm131 0 250 335h126L897 465Zm132 0 244 170v73L1028 465Z" fill="#f6d49f" opacity=".16" />
        <g stroke="#89663f" strokeWidth="1.6" opacity=".48">
          <path d="m320 465-392 335m469-335L144 800m335-335L330 800m231-335-22 335m104-335 96 335m-13-335 222 335m-139-335 359 335m-276-335 371 268" />
          <path d="M0 507h1200M0 560h1200M0 626h1200M0 709h1200M0 797h1200" />
          <path d="m266 507-38 53m297-53-7 53m292-53 38 53m-509 0-32 66m377-66 25 66m219 0 89 83m-430-83 9 83m-427-83-57 83m248 0-27 88m404-88 66 88" />
        </g>
        <g stroke="#f6ddb3" strokeWidth="1" opacity=".32">
          <path d="M0 511h1200M0 564h1200M0 630h1200M0 713h1200" />
          <path d="m366 481-140 168m280-175-67 208m201-197 18 260m144-245 102 204m-519-93-83 121m589-40 113 83" />
        </g>
        <g fill="none" stroke="#8d6c47" strokeWidth="1.2" opacity=".2">
          <path d="M83 687q23-8 39-2t39 0m175-89q19-5 32-1m84 159q24-7 40-2t32 0m240-75q14-5 30 0m253 91q24-8 46-2M610 553q16-4 28-1" />
          <ellipse cx="380" cy="654" rx="8" ry="2" /><ellipse cx="1006" cy="592" rx="7" ry="2" />
        </g>
      </g>

      {/* Low stone courses connect the interior to the original stone courtyard. */}
      <path d="m0 548 300-150h780l120 130v97l-120-160H300L0 625Z" fill={paint('stone')} />
      <path d="m0 548 300-150h780l120 130v97l-120-160H300L0 625Z" fill={paint('stone-joints')} />
      <path d="m0 542 300-148h780l120 130v10l-120-127H300L0 555Z" fill="#e4d0ab" />
      <path d="M300 90v307m780-307v308" stroke="#a08b67" strokeWidth="3" opacity=".35" />

      {/* Heavy oak beams, with separate lit edges rather than a flat ceiling band. */}
      <path d="M0 0h1200v23L1080 109H300L0 33Z" fill={paint('timber')} />
      <path d="m0 20 300 71h780l120-79v12l-120 87H300L0 38Z" fill="#6d4b32" />
      <path d="m0 16 300 72h780l120-77" fill="none" stroke="#cba06b" strokeWidth="4" opacity=".65" />
      <path d="M302 0h55l100 90h-39Z" fill={paint('timber')} />
      <path d="m349 0 104 90h-10L338 0ZM800 0h50l-80 90h-34Z" fill="#775339" />
      <path d="M808 1 746 87" stroke="#b58c5d" strokeWidth="4" />
      <path d="M284 93h25v307l-25 13Z" fill={paint('timber')} />
      <path d="M288 103v294" stroke="#ca9e69" strokeOpacity=".5" strokeWidth="3" />
      <path d="M1070 105h17v301l-17-10Z" fill={paint('timber')} />
      <g stroke="#4e3827" strokeWidth="1.3" opacity=".35" fill="none">
        <path d="m24 12 226 53m120 34h190m52 0h170m-477 25-4 85m1 32v119m782-240-3 109m-24-136 100-70" /><ellipse cx="608" cy="96" rx="9" ry="2" />
      </g>

      {/* A clipped, seasonal view uses the existing atlas without changing it. */}
      <path d="m59 120 207 31v250L59 436Z" fill="#7a5b3b" />
      <path d="m65 132 193 29v229L65 423Z" fill="#a98353" />
      <path d="m72 141 177 26v215L72 411Z" fill="#d1e1c7" />
      <g clipPath={paint('window')}>
        <svg x="66" y="141" width="191" height="271" viewBox={seasonCells[currentSeason]} preserveAspectRatio="xMidYMid slice">
          <image href={withBasePath('/seasons/home-four-seasons-v1.png')} width="1536" height="1024" />
        </svg>
        <path d="M65 140h194v276H65Z" fill="#fff2c4" opacity=".12" />
        <path d="m78 148 152 25-123 222-29 4Zm115 19 22 3-86 225-21 4Z" fill="#fff9e4" opacity=".18" />
      </g>
      <path d="m154 151 10 2v244l-10 2ZM73 270l177-1v10L73 283Z" fill={paint('timber')} />
      <path d="m157 157 2 234M79 275l165-1" fill="none" stroke="#dfbd83" strokeWidth="2" />
      <path d="m58 424 208-36 20 10-215 44Z" fill="#e5cfaa" />
      <path d="m71 442 215-44v12L71 455Z" fill="#ab8b60" />
      <path d="m44 115 238 36" stroke="#6e553a" strokeWidth="7" strokeLinecap="round" />
      <circle cx="40" cy="114" r="8" fill="#9e7b4c" /><circle cx="282" cy="151" r="8" fill="#9e7b4c" />
      <path d="m51 120 35 5q-1 105-17 158l-7 21 9 124-38 8q8-79 8-145Z" fill={paint('curtain')} />
      <path d="m239 149 32 5q-6 81-7 140l-3 93-32 6 11-97q7-73-1-147Z" fill={paint('curtain')} />
      <path d="m47 302 24-5m163-5 30 3" stroke="#ab905f" strokeWidth="5" />
      <path d="m53 134-1 155m10-146q-3 91-10 142m198-119 3 115m-12 25-5 71" fill="none" stroke="#b9aa89" strokeOpacity=".5" strokeWidth="2" />
      <ellipse cx="154" cy="440" rx="43" ry="10" fill="#887047" opacity=".13" />
      <path d="m127 416 5 24q20 7 37-3l3-28Z" fill="#dfd4b5" /><ellipse cx="150" cy="414" rx="23" ry="7" fill="#a79a75" />
      <g fill={paint('leaf')}><path d="M150 416q-29-10-26-34 22 0 26 34Z" /><path d="M151 414q-7-37 15-42 9 23-15 42Z" /><path d="M151 415q14-28 31-18-3 20-31 18Z" /></g>

      {/* Window light falls across the floor; its low contrast leaves characters clear. */}
      <path d="m70 409 177-29 418 307-356 45Z" fill="#fff1bc" opacity=".17" />
      <path d="m123 404 12-2 381 301-16 2Zm-33 74 287-39 13 10-288 46Z" fill="#7d815b" opacity=".065" />

      {/* Framed botanical print, ceramic objects and a short wall shelf. */}
      <rect x="579" y="152" width="147" height="153" rx="3" fill="#8c6946" />
      <rect x="585" y="158" width="135" height="141" rx="2" fill="#d9bb8a" />
      <rect x="593" y="166" width="119" height="125" fill="#f1e7cd" />
      <ellipse cx="653" cy="238" rx="35" ry="38" fill="#e1d8b8" opacity=".6" />
      <path d="M653 278q-13-52 9-90m-9 62-22-21m25-1 22-21" fill="none" stroke="#77815b" strokeWidth="2" />
      <g fill="#81916b"><path d="M654 246q-29-1-26-22 20 3 26 22Z" /><path d="M654 235q4-25 26-28-1 21-26 28Z" /><path d="M658 213q-17-3-15-21 16 3 15 21Z" /><path d="M660 204q3-19 17-22 2 17-17 22Z" /></g>
      <path d="M790 223h115v12H790Z" fill={paint('oak')} /><path d="m801 235 8 18 5-18m73 0 8 18 5-18" fill="#92704c" />
      <path d="M808 223v-41h12v41m4 0v-34h11v34m4 0v-45h10v45" fill="#b29b76" />
      <path d="M812 188v28m17-22v22m15-31v31" stroke="#e6cfaa" strokeWidth="2" />
      <path d="M870 190q-10 11-5 25 9 11 25 0 6-14-5-25l-1-14h-12Z" fill="#aaa888" /><ellipse cx="878" cy="177" rx="7" ry="3" fill="#7c8065" />
      <path d="m878 178 4-25m-3 13-13-12m15 5 10-12" stroke="#77825e" strokeWidth="2" fill="none" /><g fill="#8e9b72"><ellipse cx="865" cy="151" rx="7" ry="4" transform="rotate(35 865 151)" /><ellipse cx="891" cy="146" rx="7" ry="4" transform="rotate(-35 891 146)" /></g>

      {/* Sofa: a deep upholstered back, seat plane, arm fronts and visible oak feet. */}
      <ellipse cx="632" cy="502" rx="214" ry="30" fill="#604f39" opacity=".2" filter={paint('soft-shadow')} />
      <path d="m455 465 9 51h17l4-51m292 0 4 51h17l9-51" fill="#735638" />
      <path d="M449 350q0-32 29-34h296q34 0 34 34v94H449Z" fill={paint('sofa')} stroke="#7a866d" strokeWidth="2" />
      <path d="M468 338q1-9 15-10h136v98H468Zm160-10h140q20 0 20 17v81H628Z" fill="#bfc4a5" />
      <path d="M475 343h134m32 0h132" stroke="#d9d9bc" strokeWidth="2" strokeLinecap="round" />
      <path d="M457 420h343l17 47H438Z" fill={paint('seat')} stroke="#87967c" strokeWidth="2" />
      <path d="M449 459h356v32q-176 26-356 0Z" fill={paint('sofa')} />
      <path d="M451 477q177 20 352 0" fill="none" stroke="#d3d2af" strokeOpacity=".45" strokeWidth="2" />
      <path d="M439 397q-8-7-18 2l-1 71q0 24 25 25l28-2v-77q-3-25-34-19Z" fill={paint('sofa')} stroke="#849178" strokeWidth="2" />
      <path d="M788 404q0-12 18-12 27-1 32 15l3 65q0 20-24 22l-27-2Z" fill={paint('sofa')} stroke="#7e8e73" strokeWidth="2" />
      <path d="M426 408q13-12 35 0m337-3q19-10 32 3" fill="none" stroke="#d4d3b5" strokeWidth="4" strokeLinecap="round" />
      <path d="M477 357q29-13 61 3l-2 60-58 2q-8-29-1-65Z" fill={paint('cushion')} stroke="#c0b99b" strokeWidth="1.5" />
      <path d="M486 368q20-5 41 1m-41 42 39-1" stroke="#f5ecd0" strokeWidth="2" fill="none" />
      <path d="m697 355 60 2 7 64-65 1q-7-29-2-67Z" fill="#b1936e" stroke="#998361" strokeWidth="1.5" />
      <path d="m704 364 46 1m-44 8 45 1m-44 8 45 1m-44 8 45 1m-44 8 45 1m-43 8 44 1" stroke="#d6bc91" strokeOpacity=".65" strokeWidth="2" />
      <path d="m748 411 39-4 8 77q-3 9-15 11l-31 1-5-55Z" fill="#d6bd93" />
      <path d="m753 417 6 70m8-72 7 74m7-74 6 72" stroke="#b49b75" strokeWidth="2" opacity=".7" />
      <path d="m750 495 0 7m7-6 0 7m7-7 0 7m7-7 0 7m7-7 0 6m7-7 0 5" stroke="#c8ac81" strokeWidth="2" />
      <path d="M449 350q0-32 29-34h296q34 0 34 34v94l30 30q0 20-24 22l-27-2q-166 23-338-3l-28-3v-70l18-21 10 3Z" fill={paint('weave')} opacity=".6" />

      {/* Left side table and linen lamp; a book and cup make the room inhabited. */}
      <ellipse cx="361" cy="516" rx="68" ry="17" fill="#6e573c" opacity=".16" />
      <path d="m321 450 5 63h9l5-63m50 0 3 63h9l3-63" fill="#88633e" />
      <path d="M311 429h104v22H311Z" fill={paint('oak')} /><ellipse cx="363" cy="429" rx="52" ry="14" fill="#c8a16b" />
      <path d="M321 448h83v8h-83Z" fill="#8e6742" />
      <ellipse cx="351" cy="417" rx="20" ry="6" fill="#786744" /><path d="M347 322h7v93h-7Z" fill="#968157" />
      <ellipse cx="350" cy="307" rx="102" ry="91" fill={paint('lamp-glow')} />
      <path d="m320 282 60 0 18 54q-48 13-94 0Z" fill="#eee0b9" stroke="#bca982" strokeWidth="2" />
      <ellipse cx="350" cy="282" rx="30" ry="7" fill="#d5c49c" /><ellipse cx="350" cy="337" rx="47" ry="7" fill="#f4e8c4" />
      <path d="m326 289-9 41m23-39-2 42m17-42 2 42m11-43 11 41" stroke="#d0c09a" strokeWidth="1.5" />
      <path d="m366 426 31-2 8 8-33 2Z" fill="#cbbb96" /><path d="m371 434 33-2v5l-33 2Z" fill="#8b9b80" /><path d="m374 433 27-2" stroke="#f4e6c7" />
      <path d="M382 402h15l-1 17q-7 6-13 0Z" fill="#e6d7b5" /><path d="M397 405q11-1 8 8-2 5-9 2" fill="none" stroke="#d0bd98" strokeWidth="3" />

      {/* Tall corner plant occupies the edge, leaving the shared floor open. */}
      <ellipse cx="267" cy="524" rx="52" ry="17" fill="#705b3b" opacity=".15" />
      <path d="m235 469 10 52q22 12 45 0l11-52Z" fill={paint('pot')} /><ellipse cx="268" cy="470" rx="34" ry="11" fill="#ba825d" /><ellipse cx="268" cy="468" rx="28" ry="7" fill="#72553b" />
      <path d="M268 468q-10-85 1-151m-2 88-37-29m39 54 40-53m-41-23 27-29" fill="none" stroke="#69714b" strokeWidth="4" />
      <g fill={paint('leaf')} stroke="#526c43" strokeWidth="1">
        <path d="M268 391q-63-10-67-58 49-4 67 58Z" /><path d="M268 358q-36-40-14-74 39 26 14 74Z" /><path d="M274 374q4-54 48-64 15 43-48 64Z" /><path d="M271 428q17-60 68-49-6 45-68 49Z" /><path d="M265 437q-57-5-67-41 43-17 67 41Z" />
      </g>
      <g stroke="#a2ae7e" strokeWidth="1.6" opacity=".55"><path d="m210 343 51 42m0-90 7 53m44-27-35 44m51 23-48 35m-70-19 48 29" /></g>

      {/* A stone hearth, stacked logs and inset bookcase balance the right side. */}
      <ellipse cx="967" cy="505" rx="110" ry="35" fill="#785c3b" opacity=".14" filter={paint('soft-shadow')} />
      <path d="M901 263h135v226H901Z" fill={paint('stone')} stroke="#a38c67" strokeWidth="2" />
      <path d="M901 263h135v226H901Z" fill={paint('stone-joints')} />
      <path d="M914 467V361q0-52 54-52t54 52v106Z" fill="#9b8565" />
      <path d="M925 466V364q0-43 43-43t43 43v102Z" fill="#4e4436" />
      <path d="M937 459v-91q0-30 31-31t31 31v91Z" fill="#3d3930" />
      <path d="m890 259 155-1 11 15-177 1Z" fill="#c8ad80" /><path d="M879 274h177v12H879Z" fill={paint('timber')} />
      <path d="m892 278 151-1" stroke="#c29a64" strokeWidth="2" />
      <path d="M893 474h152l18 25H877Z" fill="#cab48e" /><path d="M877 499h186v10H877Z" fill="#a38b67" />
      <ellipse cx="968" cy="497" rx="116" ry="64" fill={paint('hearth-glow')} />
      <path d="m938 456 57-14 5 11-58 14Z" fill="#745135" /><path d="m943 442 47 17-4 10-47-18Z" fill="#8d633f" />
      <ellipse cx="943" cy="448" rx="5" ry="6" fill="#be9060" /><ellipse cx="995" cy="448" rx="5" ry="6" fill="#c99b68" />
      <path d="M955 451q-15-18 3-40-1 15 8 17 9-16 4-35 30 33 15 57Z" fill={paint('fire')} opacity=".88" />
      <path d="M964 452q-9-10 4-25-1 10 5 12l4-10q10 14 0 23Z" fill="#ffe1a0" />
      <path d="M920 463h96m-86-14v21m16-21v21m16-21v21m16-21v21m16-21v21m14-21v21" stroke="#5d5140" strokeWidth="3" />
      <path d="m920 247 2-37q11-11 24 0l3 37Z" fill="#e2d0a7" /><ellipse cx="934" cy="208" rx="11" ry="4" fill="#c2ac7f" />
      <path d="M927 220h14v19h-14Z" fill="#f0e1bd" /><path d="M985 235v21h23v-21" fill="#aab195" /><ellipse cx="997" cy="235" rx="12" ry="5" fill="#c9d1b0" />
      <path d="m995 230-1-25m2 16 12-9m-12-1-9-10" fill="none" stroke="#71845d" strokeWidth="2" /><g fill="#8a9a6b"><ellipse cx="984" cy="199" rx="7" ry="4" transform="rotate(35 984 199)" /><ellipse cx="1009" cy="210" rx="8" ry="4" transform="rotate(-30 1009 210)" /></g>
      <path d="M1098 183h82v350l-82-57Z" fill="#796142" /><path d="M1106 191h62v316l-62-40Z" fill="#8a714d" />
      <path d="M1106 271h62v9h-62Zm0 86h62v9h-62Zm0 87 62 14v10l-62-14Z" fill="#b08b59" />
      <path d="M1114 214h10v55h-10Zm13-8h12v63h-12Zm15 15h8v48h-8Z" fill="#b5b18b" />
      <path d="m1155 218 8-1 1 51-8 1Z" fill="#a97858" /><path d="M1117 220v42m14-50v50m14-35v35" stroke="#e1d0a5" strokeWidth="2" />
      <path d="M1116 303h37v8h-37v8h40v9h-40v8h35v12h-35Z" fill="#c1ad87" /><path d="M1116 311h37m-37 16h40m-40 11h35" stroke="#8d7656" strokeWidth="3" />
      <path d="M1139 380q-17 8-14 31 10 15 27 1 5-21-9-32l1-8h-7Z" fill="#c1b493" /><ellipse cx="1140" cy="373" rx="5" ry="2" fill="#8b8169" />
      <path d="M1116 461v10l42 28v-12Z" fill="#b89a6d" />
      <path d="m1047 456 24 3 14 43-35-2Z" fill="#aa8d61" /><path d="m1052 464 20 1 8 32-26-2Z" fill="#746043" />
      <g fill="#b68d5d" stroke="#d0ae7e" strokeWidth="1.5"><ellipse cx="1059" cy="485" rx="5" ry="7" /><ellipse cx="1067" cy="481" rx="5" ry="7" /><ellipse cx="1071" cy="492" rx="5" ry="6" /></g>

      {/* A soft, flat rug marks usable space without adding a foreground obstacle. */}
      <path d="M445 535q157-17 337-1l115 123q-242 53-528 6Z" fill="#6e593c" opacity=".09" filter={paint('soft-shadow')} />
      <path d="M447 530q157-15 333-1l108 122q-239 48-509 7Z" fill="#b9b59a" />
      <path d="M456 541q155-14 316-1l95 103q-224 40-465 5Z" fill="#d2c9a8" stroke="#e8dcbb" strokeWidth="2" />
      <path d="M469 553q147-12 293-1l79 79q-202 33-413 7Z" fill="none" stroke="#a7a88c" strokeWidth="3" />
      <path d="M447 530q157-15 333-1l108 122q-239 48-509 7Z" fill={paint('weave')} opacity=".6" />
      <g stroke="#c7bfa0" strokeWidth="2"><path d="m384 660-12 9m25-7-11 10m25-8-10 10m25-8-9 10m26-8-9 10m26-7-7 10m26-8-6 10m374-31 12 8m-27-5 11 8m-27-5 10 9m-27-6 9 9m-27-6 8 9m-28-6 8 10" /></g>

      {/* Extra guests share a foreground sofa; contact points are x=210+130n, y=655. */}
      {extraSeats > 0 && <g data-room-additional-seating="sofa" data-seat-capacity="7">
        <ellipse cx="600" cy="733" rx="483" ry="27" fill="#604f39" opacity=".17" filter={paint('soft-shadow')} />
        <path d="m173 703 7 37h17l7-37m379 0 6 37h20l6-37m381 0 7 37h17l7-37" fill="#735638" />
        <path d="M166 599q0-34 34-34h800q34 0 34 34v43H166Z" fill={paint('sofa')} stroke="#7a866d" strokeWidth="2" />
        <path d="M182 598q0-20 22-20h792q22 0 22 20v39H182Z" fill="#bfc4a5" />
        <path d="M194 584h812" stroke="#dedec0" strokeWidth="2" strokeLinecap="round" opacity=".8" />
        {[275, 405, 535, 665, 795, 925].map(x => <g key={x}>
          <path d={`M${x} 580v57`} stroke="#95a286" strokeWidth="2" opacity=".5" />
          <path d={`M${x + 3} 583v50`} stroke="#d9d9bc" strokeWidth="1.5" opacity=".65" />
        </g>)}
        <path d="M174 638h852l24 47H150Z" fill={paint('seat')} stroke="#87967c" strokeWidth="2" />
        {[275, 405, 535, 665, 795, 925].map(x => <path key={x} d={`M${x} 640v41`} fill="none" stroke="#97a58a" strokeWidth="1.5" opacity=".55" />)}
        <path d="M164 680h872v29q-436 22-872 0Z" fill={paint('sofa')} stroke="#839176" strokeWidth="1.5" />
        <path d="M169 687q431 12 862 0" fill="none" stroke="#dedcbb" strokeWidth="2.5" opacity=".75" />
        <path d="M174 706q426 16 852 0" fill="none" stroke="#76866b" strokeWidth="1.5" opacity=".45" />
        <path d="M166 599q0-34 34-34h800q34 0 34 34v39l16 47-14 24q-436 22-872 0l-14-24 16-47Z" fill={paint('weave')} opacity=".65" />
        <path d="M148 625q-18-5-19 14v51q0 24 27 26l23-2v-65q-1-24-31-24Z" fill={paint('sofa')} stroke="#849178" strokeWidth="2" />
        <path d="M1022 648q1-24 28-24 21-1 22 18v48q0 23-27 26l-23-2Z" fill={paint('sofa')} stroke="#7e8e73" strokeWidth="2" />
        <path d="M135 639q15-10 37 0m858 0q18-11 35 0" fill="none" stroke="#d4d3b5" strokeWidth="4" strokeLinecap="round" />
        <path d="m1034 638 25-2 4 65q-1 7-13 9l-20-1 1-39Z" fill="#d6bd93" />
        <path d="m1038 642-3 59m11-60-1 62m8-62 3 61" stroke="#b49b75" strokeWidth="1.5" opacity=".7" />
        <path d="m1031 709-1 6m7-5-1 6m7-5v6m6-6v6m6-7 1 6" stroke="#c8ac81" strokeWidth="2" />
      </g>}
      <path d="M0 773q604 39 1200-10v37H0Z" fill="#876845" opacity=".06" />
    </svg>
  </div>;
}
