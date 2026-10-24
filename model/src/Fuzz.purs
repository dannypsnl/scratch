-- | The fuzzer: random edits on odd formulas (Gen), run by the editor itself
-- | (Editor, a thin bridge to its JavaScript), judged by the model. After
-- | every step:
-- |   - the editor reports nothing wrong (valid document, LaTeX round trip),
-- |   - the selection is one the model can name,
-- |   - the selection is in the model's shape,
-- |   - a caret in a formula rests on one of the model's stops,
-- |   - a key the model specifies did what the model says.
-- | A failure is shrunk to the fewest steps that still fail, then printed.
-- |
-- |   FUZZ_RUNS=300 FUZZ_STEPS=40 FUZZ_SEED=1 npx spago run --main Fuzz
module Fuzz where

import Prelude hiding (sub)

import Data.Array as A
import Data.Array.NonEmpty as NEA
import Data.Foldable (for_)
import Data.Int (fromString)
import Data.Maybe (Maybe(..), fromMaybe)
import Data.String.CodeUnits as SCU
import Editor as E
import Effect (Effect)
import Effect.Console (log)
import Gen (genLine)
import Model (Box, Pos, Sel, inFormula, left, right, selectEdge, selectStep, selectTerm, shape, showBox, stops, termLeft, termRight)
import Random.LCG (mkSeed)
import Test.QuickCheck.Gen (Gen, choose, chooseInt, elements, sample, vectorOf)

type Step = { name :: String, pick :: Number }
type Case = { line :: Box, caret :: Pos, steps :: Array Step }
type Failure = { steps :: Array Step, problem :: String }

-- | A line, a caret in its formula, and a run of commands.
genCase :: Int -> Gen (Maybe Case)
genCase n = do
  line <- genLine
  k <- chooseInt 0 999
  steps <- vectorOf n genStep
  let carets = A.filter inFormula (stops line)
  pure $ (\caret -> { line, caret, steps }) <$> A.index carets (k `mod` max 1 (A.length carets))

genStep :: Gen Step
genStep = { name: _, pick: _ } <$> elements (fromMaybe (NEA.singleton "right") (NEA.fromArray E.actionNames)) <*> choose 0.0 1.0

-- | What the model says a key does to the selection, where it says anything.
expect :: String -> Box -> Sel -> Maybe Sel
expect name line s = case name of
  "right" -> caret (right line)
  "left" -> caret (left line)
  "option-right" -> caret (termRight line)
  "option-left" -> caret (termLeft line)
  "option-shift-right" -> selectTerm 1 line s
  "option-shift-left" -> selectTerm (-1) line s
  "shift-right" -> selectStep 1 line s
  "shift-left" -> selectStep (-1) line s
  "shift-cmd-right" -> selectEdge 1 line s
  "shift-cmd-left" -> selectEdge (-1) line s
  _ -> Nothing
  where
  -- a plain move, from a caret in a formula (in text the browser moves)
  caret f
    | s.anchor == s.head && inFormula s.head = (\p -> { anchor: p, head: p }) <$> f s.head
    | otherwise = Nothing

showPos :: Pos -> String
showPos p = show (map (\st -> [ st.item, st.slot ]) p.path) <> "@" <> show p.off

showSel :: Sel -> String
showSel s = if s.anchor == s.head then showPos s.head else showPos s.anchor <> ".." <> showPos s.head

-- | Run the steps; the first problem, if any.
replay :: Case -> Array Step -> Maybe String
replay c steps = go (E.start c.line c.caret) steps
  where
  go ed todo = case A.uncons todo of
    Nothing -> Nothing
    Just { head: step, tail } ->
      let
        line = E.lineOf ed
        before = E.selectionOf ed
        r = E.act step.name step.pick ed
        after = E.selectionOf r.editor
        line' = E.lineOf r.editor
        sel = { anchor: after.anchor, head: after.head }
        problem
          | r.error /= "" = Just r.error
          | E.problems r.editor /= "" = Just (E.problems r.editor)
          | not after.found = Just "the selection is at a place the model has no position for"
          | shape line' sel /= sel = Just ("selection not in shape: " <> showSel sel <> ", the model's shape " <> showSel (shape line' sel))
          | sel.anchor == sel.head && inFormula sel.head && not (A.elem sel.head (stops line')) = Just ("the caret rests at " <> showPos sel.head <> ", not a stop")
          | otherwise = case expect step.name line { anchor: before.anchor, head: before.head } of
              Just want | before.found && line' == line ->
                if want == sel then Nothing else Just (step.name <> ": the model says " <> showSel want <> ", the editor gives " <> showSel sel)
              _ -> Nothing
      in
        case problem of
          Just p -> Just (step.name <> " -> " <> p)
          Nothing -> go r.editor tail

-- | Drop steps, last first, while it still fails.
shrink :: Case -> Array Step -> Array Step
shrink c steps = go (A.length steps - 1) steps
  where
  go i best
    | i < 0 = best
    | otherwise =
        let fewer = fromMaybe best (A.deleteAt i best)
        in go (i - 1) (if replay c fewer /= Nothing then fewer else best)

main :: Effect Unit
main = do
  let
    number name fallback = fromMaybe fallback (fromString (E.env name (show fallback)))
    runs = number "FUZZ_RUNS" 300
    stepsPer = number "FUZZ_STEPS" 40
    seed = number "FUZZ_SEED" 1
    cases = A.catMaybes (sample (mkSeed seed) runs (genCase stepsPer))
    failures = A.mapMaybe (\c -> (\_ -> c) <$> replay c c.steps) cases
    -- one example of each kind of failure: the step and what went wrong
    kind problem = SCU.takeWhile (_ /= ':') problem
    report = A.nubByEq (\a b -> kind a.problem == kind b.problem) (map (\c -> let s = shrink c c.steps in { c, steps: s, problem: fromMaybe "" (replay c s) }) failures)
  for_ report \f -> do
    log ("\n" <> f.problem)
    log ("  start: $" <> E.latexOf (E.start f.c.line f.c.caret) <> "$, caret " <> showPos f.c.caret)
    log ("  steps: " <> A.intercalate ", " (map _.name f.steps))
  log ("\n" <> show (A.length cases) <> " runs of " <> show stepsPer <> " steps (seed " <> show seed <> "): " <> show (A.length failures) <> " failed, " <> show (A.length report) <> " kinds")
  when (A.length failures > 0) (E.exitWith 1)
