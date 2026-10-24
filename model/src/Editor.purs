-- | The editor (src/, JavaScript) seen through a thin bridge: a line goes in,
-- | its own commands run, the line and selection come back in the model's
-- | terms. The bridge decides nothing; the fuzzer judges.
module Editor where

import Prelude (Unit)
import Effect (Effect)
import Model (Box, Pos)

foreign import data Editor :: Type

-- | The editor's commands, by name ("right", "type ^", "\\frac", "rewrite", …).
foreign import actionNames :: Array String

-- | A line with the caret at a place.
foreign import start :: Box -> Pos -> Editor

-- | A command, with a number in [0, 1) for the ones that pick (a rewrite);
-- | error is what it threw, or "".
foreign import act :: String -> Number -> Editor -> { editor :: Editor, error :: String }

foreign import lineOf :: Editor -> Box

-- | found is false when the editor's selection is at a place the model has
-- | no position for.
foreign import selectionOf :: Editor -> { found :: Boolean, anchor :: Pos, head :: Pos }

-- | What only the editor can tell: an invalid document, a selection that is
-- | not a text selection, a formula whose LaTeX does not survive the editor's
-- | own write and read ("" when none).
foreign import problems :: Editor -> String

foreign import latexOf :: Editor -> String

foreign import env :: String -> String -> String

foreign import exitWith :: Int -> Effect Unit
