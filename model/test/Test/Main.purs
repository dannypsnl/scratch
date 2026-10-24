-- | Laws the model must keep, on random lines.
module Test.Main where

import Prelude hiding (sub)

import Data.Array as A
import Data.Foldable (all)
import Data.Maybe (Maybe(..), fromMaybe, isJust)
import Effect (Effect)
import Effect.Console (log)
import Gen (genLine)
import Model (Box, Pos, balanced, selectStep, selectEdge, containerAt, inFormula, scope, unitIsOp, unitStart, kind, left, nameOf, replaceIn, rewrites, right, selectTerm, shape, showBox, slotsOf, stops, termLeft, termRight, betweenPair)
import Test.QuickCheck (Result(..), quickCheckGen')

-- the first failure among the cases, or Success
every :: forall a. Array a -> (a -> Result) -> Result
every xs f = fromMaybe Success (A.findMap (\x -> case f x of
  Success -> Nothing
  failed -> Just failed) xs)

check :: Boolean -> String -> Result
check true _ = Success
check false msg = Failed msg

law :: String -> (Box -> Result) -> Effect Unit
law name f = do
  log name
  quickCheckGen' 300 (f <$> genLine)

showPos :: Pos -> String
showPos p = show (map (\s -> [ s.item, s.slot ]) p.path) <> "@" <> show p.off

main :: Effect Unit
main = do
  law "right then left comes back" \line -> every (stops line) \p ->
    case right line p of
      Just q | A.elem q (stops line) -> check (left line q == Just p) (showBox line <> ": right " <> showPos p <> " -> " <> showPos q <> ", left -> " <> show (map showPos (left line q)))
      _ -> Success

  law "left then right comes back" \line -> every (stops line) \p ->
    case left line p of
      Just q | A.elem q (stops line) -> check (right line q == Just p) (showBox line <> ": left " <> showPos p <> " -> " <> showPos q <> ", right -> " <> show (map showPos (right line q)))
      _ -> Success

  law "right and left only ever rest on stops" \line -> every (A.filter inFormula (stops line)) \p ->
    let next = A.catMaybes [ right line p, left line p ]
    in every next \q -> check (not (inFormula q) || A.elem q (stops line)) (showBox line <> ": " <> showPos p <> " -> " <> showPos q)

  law "option steps stop where a term meets an operator, or at a group's edge" \line -> every (A.filter inFormula (stops line)) \p ->
    case termRight line p, containerAt line p.path of
      Just q, Just box | q.path == p.path ->
        let sc = scope box p.off
            outOfGroup = map (\g -> g.close + 1) sc.group == Just q.off && p.off == sc.hi
            boundary = q.off == sc.hi || unitIsOp box q.off /= unitIsOp box (unitStart box q.off)
        in check (q.off > p.off && (outOfGroup || boundary)) (showBox line <> ": option-right " <> showPos p <> " -> " <> showPos q)
      _, _ -> Success

  law "option steps from inside a group never pass its parentheses" \line -> every (A.filter inFormula (stops line)) \p ->
    case containerAt line p.path of
      Just box | Just g <- (scope box p.off).group ->
        let r = termRight line p
            l = termLeft line p
            okR = case r of
              Just q | q.path == p.path -> q.off <= g.close || (p.off == g.close && q.off == g.close + 1)
              _ -> true
            okL = case l of
              Just q | q.path == p.path -> q.off > g.open || (p.off == g.open + 1 && q.off == g.open)
              _ -> true
        in check (okR && okL) (showBox line <> ": from " <> showPos p <> " right " <> show (map showPos r) <> " left " <> show (map showPos l))
      _ -> Success

  law "option left undoes option right within a run" \line -> every (A.filter inFormula (stops line)) \p ->
    case termRight line p, containerAt line p.path of
      Just q, Just box | q.path == p.path && runStart box p.off && q.off <= (scope box p.off).hi -> check (termLeft line q == Just p) (showBox line <> ": " <> showPos p <> " -> " <> showPos q <> " -> " <> show (map showPos (termLeft line q)))
      _, _ -> Success

  law "shape is idempotent and keeps both ends in one container" \line ->
    let ps = allPositions line
    in every ps \a -> every ps \h ->
      let s = shape line { anchor: a, head: h }
      in check (shape line s == s && s.anchor.path == s.head.path && notBetween line s) (showBox line <> ": " <> showSel { anchor: a, head: h } <> " -> " <> showSel s)

  law "a selection begun in a formula ends in it, however far the other end goes" \line ->
    let ps = allPositions line
    in every (A.filter inFormula ps) \a -> every ps \h ->
      let r = shape line { anchor: a, head: h }
      in check (A.head r.anchor.path == A.head a.path && A.head r.head.path == A.head a.path) (showBox line <> ": " <> showSel { anchor: a, head: h } <> " -> " <> showSel r)

  law "shift and shift-cmd selections are in shape and stay in the formula" \line -> every (A.filter inFormula (stops line)) \p ->
    every [ 1, -1 ] \dir ->
      let sels = A.catMaybes [ selectStep dir line { anchor: p, head: p }, selectEdge dir line { anchor: p, head: p } ]
      in every sels \r -> check (shape line r == r && A.head r.head.path == A.head p.path) (showBox line <> ": " <> showPos p <> " -> " <> showSel r)

  law "option-shift selections are in shape and stay in the formula" \line -> every (A.filter inFormula (stops line)) \p ->
    every [ 1, -1 ] \dir -> case selectTerm dir line { anchor: p, head: p } of
      Just s -> check (shape line s == s && inFormula s.head) (showBox line <> ": " <> showPos p <> " -> " <> showSel s)
      Nothing -> Failed (showBox line <> ": no selection from " <> showPos p)

  law "a fraction made a/b and back is the same fraction" \line -> every (fracs line) \{ path, i } ->
    case A.find (\r -> r.id == "slash") (rewrites line path i (i + 1)) of
      -- none only when a side's parentheses do not pair up
      Nothing -> check (not (all balanced (fromMaybe [] (map slotsOf (containerAt line path >>= \b -> A.index b i)))))
        (showBox line <> ": no a/b for the fraction at " <> show i)
      Just r ->
        let line' = replaceIn line path i (i + 1) r.replace
            back = A.find (\r' -> r'.id == "frac") (rewrites line' path i (i + A.length r.replace))
        in case back of
          Nothing -> Failed (showBox line' <> ": no way back")
          Just b -> check (replaceIn line' path i (i + A.length r.replace) b.replace == line) (showBox line <> " -> " <> showBox line' <> " -> " <> showBox (replaceIn line' path i (i + A.length r.replace) b.replace))
  where
  showSel s = showPos s.anchor <> ".." <> showPos s.head
  notBetween line s = case containerAt line s.head.path of
    Just box -> s.anchor /= s.head || not (betweenPair box s.head.off)
    Nothing -> false
  -- a run starts at p: nothing of the same kind just before it
  runStart box off = off <= (scope box off).lo || unitIsOp box (unitStart box off) /= unitIsOp box off

-- | Every position, stops or not (between pairs too): what a click may give.
allPositions :: Box -> Array Pos
allPositions line = go [] line
  where
  go path box = map (\off -> { path, off }) (A.range 0 (A.length box))
    <> A.concat (A.mapWithIndex (\i it -> A.concat (A.mapWithIndex (\k s -> go (A.snoc path { item: i, slot: k }) s) (slotsOf it))) box)

-- | Where the fractions are.
fracs :: Box -> Array { path :: Array { item :: Int, slot :: Int }, i :: Int }
fracs line = go [] line
  where
  go path box = A.concat (A.mapWithIndex (\i it ->
    (if kind it == "struct" && nameOf it == "frac" && not (A.null path) then [ { path, i } ] else [])
      <> A.concat (A.mapWithIndex (\k s -> go (A.snoc path { item: i, slot: k }) s) (slotsOf it))) box)
