/**
 * A rotor as a thrust disc (Proposal 0004, Rotor as a Thrust Disc): closed-form
 * blade-element integrals for thrust and torque with uniform inflow and linear
 * twist, Glauert's momentum inflow, Cheeseman and Bennett's ground effect, and
 * the steady flapping of the tip-path plane in forward flight. Pure functions of
 * nondimensional quantities (Johnson, Helicopter Theory; Leishman, Principles of
 * Helicopter Aerodynamics), shared by the main and tail rotors and by the
 * control layer that inverts them.
 *
 * Notation: σ solidity, a lift slope, θ₇₅ blade pitch at 0.75 R, θtw linear
 * twist, μ advance ratio (in-plane air speed / tip speed), λ total inflow ratio
 * (down through the disc, + in a climb: λ = λc + λi), B tip-loss factor.
 */

/**
 * Thrust coefficient C_T = T / (ρ A (ΩR)²) for blade pitch `theta75` at 0.75 R,
 * twist `twist`, advance ratio `mu` and inflow ratio `lambda` (uniform inflow,
 * tip loss B on the outer radius).
 */
export function thrustCoefficient(
  sigma: number,
  a: number,
  theta75: number,
  twist: number,
  mu: number,
  lambda: number,
  B: number,
): number {
  const theta0 = theta75 - 0.75 * twist;
  const B2 = B * B;
  const mu2 = mu * mu;
  return (
    0.5 *
    sigma *
    a *
    (theta0 * ((B2 * B) / 3 + 0.5 * B * mu2) +
      twist * ((B2 * B2) / 4 + 0.25 * B2 * mu2) -
      0.5 * lambda * B2)
  );
}

/**
 * Glauert's induced inflow for thrust coefficient `ct` at advance ratio `mu`
 * and total inflow `lambda`: λi = C_T / (2 √(μ² + λ²)). The velocity under the
 * root is held at least `floor`, which keeps the induced inflow finite where
 * momentum theory has no solution (a slow vertical descent through the
 * rotor's own wake).
 */
export function glauertInflow(ct: number, mu: number, lambda: number, floor: number): number {
  return ct / (2 * Math.max(floor, Math.sqrt(mu * mu + lambda * lambda)));
}

/**
 * Ground effect (Cheeseman and Bennett): the factor on the induced inflow at
 * hub height `z` over the ground for a rotor of radius `R`, 1 − (R / 4z)², faded
 * out with forward speed (μ against the hover's inflow `lambdaH`). Held at its
 * value at z = R/2 below that.
 */
export function groundEffect(R: number, z: number, mu: number, lambdaH: number): number {
  const zz = Math.max(z, 0.5 * R);
  const k = (R / (4 * zz)) ** 2;
  // Past about twice the hover's induced speed, the wake sweeps behind and the cushion is gone.
  const fade = 1 / (1 + (mu / Math.max(1e-3, 1.5 * lambdaH)) ** 2);
  return 1 - k * fade;
}

/** Profile-power coefficient σ C_d0 / 8 · (1 + 4.65 μ²). */
export function profilePower(sigma: number, cd0: number, mu: number): number {
  return ((sigma * cd0) / 8) * (1 + 4.65 * mu * mu);
}

/**
 * Power (= torque) coefficient C_P = κ C_T λi + C_T λc + profile: induced, climb
 * (and, through the disc's forward tilt, parasite), and profile power.
 */
export function powerCoefficient(
  ct: number,
  lambdaI: number,
  lambdaC: number,
  kappa: number,
  profile: number,
): number {
  return kappa * ct * lambdaI + ct * lambdaC + profile;
}

/**
 * Steady flapping of the tip-path plane in forward flight, against the shaft:
 * the disc blows back away from the in-plane wind by `back` (rad) and tilts
 * toward the advancing side by `side` (rad), from coning (γ the Lock number).
 */
export function forwardFlapping(
  theta75: number,
  mu: number,
  lambda: number,
  lock: number,
): { back: number; side: number; coning: number } {
  const coning = (lock / 8) * (theta75 - (4 / 3) * lambda);
  const back = (2 * mu * ((4 / 3) * theta75 - lambda)) / (1 + 1.5 * mu * mu);
  const side = ((4 / 3) * mu * coning) / (1 + 0.5 * mu * mu);
  return { back, side, coning };
}

/** Inflow time constant (s), after Pitt and Peters: 0.849 / (4 Ω λ), λ held at least 0.02, within 0.03–0.4 s. */
export function inflowTime(omega: number, lambda: number): number {
  const t = 0.849 / (4 * Math.max(omega, 1) * Math.max(0.02, Math.abs(lambda)));
  return Math.min(0.4, Math.max(0.03, t));
}
