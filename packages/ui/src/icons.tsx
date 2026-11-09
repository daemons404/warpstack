import Svg, { Circle, Path } from 'react-native-svg'

// Icons, as path data from three open sources, so the app looks like the Farcaster client
// without depending on its packages:
//
// - Cast actions (reply, recast, like, quote, pencil, more, photo): Octicons, as the Farcaster client
//   uses them. MIT License, Copyright (c) GitHub Inc. https://github.com/primer/octicons
// - Home and notifications tabs: the Farcaster client's tab icons (40-point box, 2-point
//   stroke, filled when selected). MIT License, Copyright (c) Merkle Manufactory Inc.
//   https://github.com/farcasterxyz/client
// - Settings tab: Lucide's `settings`, scaled to the same box. ISC License, Copyright (c)
//   Lucide Icons and Contributors. https://lucide.dev
// - X's mark on post cards: Simple Icons' `x`, CC0 1.0. https://simpleicons.org
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software
// and associated documentation files, to deal in the software without restriction, subject to
// the above copyright notices being included in all copies or substantial portions. The
// software is provided "as is", without warranty of any kind.

type IconProps = { color: string; size?: number }

// Cast actions: 16-point Octicons.

export const ReplyIcon = ({ color, size = 16 }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <Path fill={color} d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25v-7.5Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.75.75 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25H2.75Z" />
  </Svg>
)

export const RecastIcon = ({ color, size = 16 }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <Path fill={color} d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.003 7.003 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834h-.001ZM8 2.5a5.487 5.487 0 0 0-4.131 1.87l1.204 1.203A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 1 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z" />
  </Svg>
)

export const HeartIcon = ({ color, size = 16, filled }: IconProps & { filled?: boolean }) => (
  <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    {filled
      ? <Path fill={color} d="M7.655 14.916v-.001h-.002l-.006-.003-.018-.01a22.064 22.064 0 0 1-3.744-2.584C2.045 10.731 0 8.35 0 5.5 0 2.836 2.086 1 4.25 1 5.797 1 7.153 1.802 8 3.02 8.847 1.802 10.203 1 11.75 1 13.914 1 16 2.836 16 5.5c0 2.85-2.044 5.231-3.886 6.818a22.089 22.089 0 0 1-3.433 2.414c-.102.06-.205.116-.31.17l-.018.01-.008.004a.75.75 0 0 1-.69 0Z" />
      : <Path fill={color} d="m8 14.25.345.666a.75.75 0 0 1-.69 0l-.008-.004-.018-.01a7.163 7.163 0 0 1-.31-.17 22.059 22.059 0 0 1-3.434-2.414C2.045 10.731 0 8.35 0 5.5 0 2.836 2.086 1 4.25 1 5.797 1 7.153 1.802 8 3.02 8.847 1.802 10.203 1 11.75 1 13.914 1 16 2.836 16 5.5c0 2.85-2.045 5.231-3.885 6.818a22.063 22.063 0 0 1-3.744 2.584l-.018.01-.006.003h-.002L8 14.25ZM4.25 2.5c-1.336 0-2.75 1.164-2.75 3 0 2.15 1.58 4.144 3.365 5.682A20.581 20.581 0 0 0 8 13.393a20.582 20.582 0 0 0 3.135-2.211C12.92 9.644 14.5 7.65 14.5 5.5c0-1.836-1.414-3-2.75-3-1.373 0-2.609.986-3.029 2.456a.749.749 0 0 1-1.442 0C6.859 3.486 5.623 2.5 4.25 2.5Z" />}
  </Svg>
)

export const QuoteIcon = ({ color, size = 16 }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <Path fill={color} d="M1.75 2.5h10.5a.75.75 0 0 1 0 1.5H1.75a.75.75 0 0 1 0-1.5Zm4 5h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1 0-1.5Zm0 5h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1 0-1.5ZM2.5 7.75v6a.75.75 0 0 1-1.5 0v-6a.75.75 0 0 1 1.5 0Z" />
  </Svg>
)

/** Quote, in the recast menu: write something about a cast. */
export const PencilIcon = ({ color, size = 16 }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <Path fill={color} d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z" />
  </Svg>
)

export const MoreIcon = ({ color, size = 16 }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <Path fill={color} d="M8 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM1.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm13 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
  </Svg>
)

export const PersonIcon = ({ color, size = 16 }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <Path fill={color} d="M4.243 4.757a3.757 3.757 0 1 1 5.851 3.119 6.006 6.006 0 0 1 3.9 5.339.75.75 0 0 1-.715.784H2.721a.75.75 0 0 1-.714-.784 6.006 6.006 0 0 1 3.9-5.34 3.753 3.753 0 0 1-1.664-3.118Z" />
  </Svg>
)

export const PhotoIcon = ({ color, size = 16 }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <Path fill={color} d="M16 13.25A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75ZM1.75 2.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h.94l.03-.03 6.077-6.078a1.75 1.75 0 0 1 2.412-.06L14.5 10.31V2.75a.25.25 0 0 0-.25-.25Zm12.5 11a.25.25 0 0 0 .25-.25v-.917l-4.298-3.889a.25.25 0 0 0-.344.009L4.81 13.5ZM7 6a2 2 0 1 1-3.999.001A2 2 0 0 1 7 6ZM5.5 6a.5.5 0 1 0-1 0 .5.5 0 0 0 1 0Z" />
  </Svg>
)

export const LinkIcon = ({ color, size = 16 }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <Path fill={color} d="m7.775 3.275 1.25-1.25a3.5 3.5 0 1 1 4.95 4.95l-2.5 2.5a3.5 3.5 0 0 1-4.95 0 .751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018 1.998 1.998 0 0 0 2.83 0l2.5-2.5a2.002 2.002 0 0 0-2.83-2.83l-1.25 1.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042Zm-4.69 9.64a1.998 1.998 0 0 0 2.83 0l1.25-1.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042l-1.25 1.25a3.5 3.5 0 1 1-4.95-4.95l2.5-2.5a3.5 3.5 0 0 1 4.95 0 .751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018 1.998 1.998 0 0 0-2.83 0l-2.5 2.5a1.998 1.998 0 0 0 0 2.83Z" />
  </Svg>
)

/** X's mark, for posts from X, as the Farcaster client shows them. */
export const XIcon = ({ color, size = 12 }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path fill={color} d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
  </Svg>
)

// Tabs: a 40-point box with a 2-point stroke; selected tabs are filled.

type TabIconProps = { color: string; background: string; selected: boolean; size?: number }

const DOOR = 'M23 29V21C23 20.7348 22.8946 20.4804 22.7071 20.2929C22.5196 20.1054 22.2652 20 22 20H18C17.7348 20 17.4804 20.1054 17.2929 20.2929C17.1054 20.4804 17 20.7348 17 21V29'
const HOUSE = 'M11 18C10.9999 17.7091 11.0633 17.4216 11.1858 17.1577C11.3082 16.8938 11.4868 16.6598 11.709 16.472L18.709 10.473C19.07 10.1679 19.5274 10.0005 20 10.0005C20.4726 10.0005 20.93 10.1679 21.291 10.473L28.291 16.472C28.5132 16.6598 28.6918 16.8938 28.8142 17.1577C28.9367 17.4216 29.0001 17.7091 29 18V27C29 27.5304 28.7893 28.0391 28.4142 28.4142C28.0391 28.7893 27.5304 29 27 29H13C12.4696 29 11.9609 28.7893 11.5858 28.4142C11.2107 28.0391 11 27.5304 11 27V18Z'

export const HomeTabIcon = ({ color, background, selected, size = 40 }: TabIconProps) => (
  <Svg width={size} height={size} viewBox="0 0 40 40" fill="none">
    <Path d={HOUSE} fill={selected ? color : 'none'} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    {selected && <Path d={DOOR} fill={background} />}
    <Path d={selected ? `${DOOR}H23Z` : DOOR} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
)

const BELL = 'M14 16C14 14.4087 14.6321 12.8826 15.7574 11.7574C16.8826 10.6321 18.4087 10 20 10C21.5913 10 23.1174 10.6321 24.2426 11.7574C25.3679 12.8826 26 14.4087 26 16C26 23 29 25 29 25H11C11 25 14 23 14 16Z'
const CLAPPER = 'M18.3 29C18.4674 29.3044 18.7135 29.5583 19.0125 29.7352C19.3116 29.912 19.6526 30.0053 20 30.0053C20.3475 30.0053 20.6885 29.912 20.9876 29.7352C21.2866 29.5583 21.5327 29.3044 21.7 29'

export const BellTabIcon = ({ color, selected, size = 40 }: TabIconProps) => (
  <Svg width={size} height={size} viewBox="0 0 40 40" fill="none">
    <Path d={BELL} fill={selected ? color : 'none'} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    <Path d={CLAPPER} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
)

const GEAR = 'M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915'

/** Lucide's 24-point gear, drawn at the tab icons' 18-point glyph size inside the 40 box. */
export const SettingsTabIcon = ({ color, background, selected, size = 40 }: TabIconProps) => (
  <Svg width={size} height={size} viewBox="-8 -8 40 40" fill="none">
    <Path d={GEAR} fill={selected ? color : 'none'} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    <Circle cx={12} cy={12} r={3} fill={selected ? background : 'none'} stroke={color} strokeWidth={2} />
  </Svg>
)
