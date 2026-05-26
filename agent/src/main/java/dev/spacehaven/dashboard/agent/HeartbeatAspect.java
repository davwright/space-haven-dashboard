package dev.spacehaven.dashboard.agent;

import java.util.concurrent.atomic.AtomicLong;
import java.util.function.LongConsumer;
import org.aspectj.lang.annotation.Aspect;
import org.aspectj.lang.annotation.Before;
import org.aspectj.lang.annotation.Pointcut;

/**
 * AspectJ aspect that hooks into Space Haven's game-loop update path and
 * counts ticks.
 *
 * <p>This is the proof-of-life. We don't extract any game state — we just
 * confirm that load-time weaving worked and we can observe the game's tick
 * rate from inside the JVM.
 *
 * <p><b>Pointcut choice.</b> Space Haven uses the libGDX-style framework
 * class {@code fi.bugbyte.framework.Game} as its top-level
 * application/screen container, and {@code fi.bugbyte.spacehaven.SpaceHaven}
 * extends it as the actual game. Both expose {@code render(...)} which is
 * the per-frame entry. We match {@code SpaceHaven.render(..)} as the most
 * stable hook: it fires every visible frame (~60 Hz), survives game-version
 * bumps because the class name has been stable for years, and is only
 * called once the game is fully constructed (no NPEs during init).
 *
 * <p>If the method name ever changes, fall back to the broader pointcut
 * {@code execution(* fi.bugbyte.spacehaven.SpaceHaven.*(..))} — it weaves
 * more methods but the {@code @Before} body is dirt-cheap.
 */
@Aspect
public class HeartbeatAspect {

  private static final AtomicLong TICKS = new AtomicLong();
  private static final int LOG_EVERY = 100;
  private static volatile LongConsumer sink;

  /** Installed by {@link Agent} once the bridge exists. May be null early on. */
  public static void setSink(LongConsumer s) {
    sink = s;
  }

  @Pointcut("execution(* fi.bugbyte.spacehaven.SpaceHaven.render(..))")
  public void gameRender() {}

  @Before("gameRender()")
  public void beforeRender() {
    long n = TICKS.incrementAndGet();
    if (n % LOG_EVERY == 0) {
      System.out.println("[sh-agent] tick=" + n);
    }
    LongConsumer s = sink;
    if (s != null) s.accept(n);
  }
}
