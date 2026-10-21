export const colors = {
  bg: '#050B18', card: '#151B2D', border: '#28324A', text: '#F5F7FF', muted: '#A3AEC7', faint: '#6F7B96',
  primary: '#7C5CFF', primaryDark: '#6246D9', green: '#34D399', greenBg: '#123A37', amber: '#F7B84B', amberBg: '#3A2B13',
  red: '#FB7185', redBg: '#3B1D2A', blue: '#60A5FA', blueBg: '#172D4D', muted2: '#202940',
  surfaceRaised: '#1B2338', surfaceSoft: '#11182A', white: '#FFFFFF',
};
export const spacing = (n: number) => n * 4;
export const radius = { sm: 12, md: 16, lg: 20, pill: 999 };

// Premium design system — visual source of truth for redesigned screens.
export const premium = {
  background: '#050B18', surface: '#0D1629', surfaceElevated: '#111D33', surfaceSoft: '#16223A',
  primary: '#FFAA32', primaryDark: '#C97812', purple: '#6C5CE7', purpleSoft: '#8B7CFF',
  success: '#19D88B', danger: '#FF5368', warning: '#FFB340',
  text: '#F7F8FC', textSecondary: '#AAB6CF', textMuted: '#71809D', border: '#23314B', divider: '#26344E',
};
export const premiumRadius = { small: 12, medium: 18, large: 24, xlarge: 30, pill: 999 };
// Light design system — used by the redesigned design_pref screens (auth, Home).
export const light = {
  background: '#FFFFFF', surface: '#FFFFFF', ink: '#18181B', onInk: '#FFFFFF',
  text: '#18181B', textLabel: '#3F3F46', textSecondary: '#71717A', placeholder: '#A1A1AA',
  border: '#E4E4E7', divider: '#D4D4D8', link: '#2563EB', accentDot: '#3B82F6', danger: '#DC2626', dangerBg: '#FEF2F2',
  soft: '#F4F4F5', track: '#E4E4E7', success: '#16A34A', successBg: '#F0FDF4', linkBg: '#EFF6FF', warning: '#B45309', warningBg: '#FFFBEB',
};
export const lightRadius = { field: 14, button: 16, mark: 10 };
export const premiumShadow ={ shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 8 };
