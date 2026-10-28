// The evolved forms' animations, about 2 MB of GIFs (the two cinematic ones are
// 40 frames each). Inlined like the companion GIFs, because the page cannot fetch
// under connect-src 'none', but in a chunk of their own: Otter.tsx imports this
// module the first time an evolved form is shown, so the pet and the panel start
// without it.
import artisanWork from "./assets/evolution/artisan_work.gif?inline";
import artisanWaiting from "./assets/evolution/artisan_waiting.gif?inline";
import artisanSuccess from "./assets/evolution/artisan_success.gif?inline";
import deepWork from "./assets/evolution/deep_work.gif?inline";
import deepWaiting from "./assets/evolution/deep_waiting.gif?inline";
import deepSuccess from "./assets/evolution/deep_success.gif?inline";
import toArtisan from "./assets/evolution/to_artisan.gif?inline";
import toDeep from "./assets/evolution/to_deep.gif?inline";
import fromArtisan from "./assets/evolution/from_artisan.gif?inline";
import fromDeep from "./assets/evolution/from_deep.gif?inline";
import cinematicArtisan from "./assets/evolution/to_artisan_cinematic.gif?inline";
import cinematicDeep from "./assets/evolution/to_deep_cinematic.gif?inline";

export type EvolutionGifs = {
  work: string;
  waiting: string;
  success: string;
  to: string;
  cinematic: string;
  from: string;
};

export const EVOLUTION: Record<"artisan" | "deep", EvolutionGifs> = {
  artisan: {
    work: artisanWork,
    waiting: artisanWaiting,
    success: artisanSuccess,
    to: toArtisan,
    cinematic: cinematicArtisan,
    from: fromArtisan,
  },
  deep: {
    work: deepWork,
    waiting: deepWaiting,
    success: deepSuccess,
    to: toDeep,
    cinematic: cinematicDeep,
    from: fromDeep,
  },
};
