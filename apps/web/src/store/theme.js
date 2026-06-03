import { create } from 'zustand';

/**
 * Selectable skins. `id` is the value written to <html data-theme>; themes.css holds
 * the token overrides. `label` is shown grouped (Family - Name); `sw` is the picker swatch.
 * Default = 'arcade' (the original Retro pixel look, defined in index.css :root).
 */
export const SKINS = [
  { id: 'arcade',    label: 'Retro - Arcade',         sw: 'linear-gradient(135deg,#111418,#f0c040)' },
  { id: 'indigo',    label: 'Pokémon - Indigo',       sw: 'linear-gradient(135deg,#0a1430,#ffcb05)' },
  { id: 'voltage',   label: 'Pokémon - Voltage',      sw: 'linear-gradient(135deg,#FFCB05,#3D7DCA)' },
  { id: 'bounty',    label: 'One Piece - Bounty',     sw: 'linear-gradient(135deg,#140a0c,#f4b41a)' },
  { id: 'grandline', label: 'One Piece - Grand Line', sw: 'linear-gradient(135deg,#E0A82E,#C8453B)' },
  { id: 'antiquity', label: 'Magic - Antiquity',      sw: 'linear-gradient(135deg,#120e09,#c8aa6e)' },
  { id: 'mythic',    label: 'Magic - Mythic',         sw: 'linear-gradient(135deg,#C9A227,#7A4FB5)' },
];

const KEY = 'pokeX_skin';
const isValid = (id) => SKINS.some((s) => s.id === id);
export const initialSkin = () => {
  const s = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
  return isValid(s) ? s : 'arcade';
};

export const useTheme = create((set) => ({
  skin: initialSkin(),
  setSkin(id) {
    if (!isValid(id)) return;
    localStorage.setItem(KEY, id);
    document.documentElement.setAttribute('data-theme', id);
    set({ skin: id });
  },
}));
