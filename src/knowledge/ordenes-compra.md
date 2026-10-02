# Conocimiento del proceso

Un paquete incluye correo, solicitud, cotización y aprobación; puede incluir factura. Las herramientas son la autoridad sobre maestros y reglas, este texto orienta el comportamiento.

RC1: proveedor existente y activo, búsqueda por NIT o nombre normalizado sin NIT. RC2: correo de aprobación presente, aprobado y emitido por un aprobador autorizado del centro. RC3: monto dentro del tope del aprobador. RC4: subárea del centro. RC10: cantidad por valor unitario igual al total con tolerancia de una unidad. Estas reglas son bloqueos que requieren corrección humana, nunca confirmación para omitirlas.

RC5: diferencia de cotización superior al 2% o cotización ausente requieren confirmación. RC6: IVA ausente se deriva del proveedor y requiere confirmación. RC7: condiciones de pago ausentes se derivan del proveedor y se informan. RC8: factura anterior a la solicitud marca retroactiva y requiere confirmación. RC9: aprobación anterior a la solicitud requiere confirmación.

Los casos de demostración son sol-001 válido, sol-002 proveedor inexistente, sol-003 aprobador sin autoridad, sol-004 diferencia de cotización, sol-005 retroactivo y sol-006 IVA ausente. Los datos exactos se leen con herramientas, no se toman de esta descripción.

La evidencia conserva encabezados y cuerpo de aprobación con hash. El SAP es simulado, asigna números secuenciales e impide duplicados por referencia. Trazabilidad y control se guardan en out/. Una OC retroactiva se mide; el agente no decide cambiar la política empresarial.
