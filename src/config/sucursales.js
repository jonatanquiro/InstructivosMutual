// Mapeo fijo de idsucursal, igual en TODAS las tablas de la DW.
// 0 = Casa Central, 1 = Rafaela, 2 = Humberto, 3 = Moisés Ville.
// El color es el mismo en todos los gráficos de "Proyectos", para que una
// sucursal siempre se identifique igual sin importar el módulo que mires.
const SUCURSALES = {
  0: { nombre: "Casa Central", color: "#00915a" },
  1: { nombre: "Rafaela", color: "#2f7fd1" },
  2: { nombre: "Humberto", color: "#e0a83f" },
  3: { nombre: "Moisés Ville", color: "#8e5fd1" },
};

module.exports = { SUCURSALES };
