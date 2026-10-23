package dev.gtnhplanner.calcoracle;

import java.util.List;
import java.util.Map;

/**
 * Exports the mining domain (dimensions, ore veins, small ores, underground fluids).
 * The NEI ore plugin API it reads differs between GT versions, so the implementation
 * lives in a per-pack source dir and only this interface is shared.
 */
public interface MiningExport {
    Map<String, Object> exportMining(List<Map<String, Object>> adapters, MiningContext ctx);
}
